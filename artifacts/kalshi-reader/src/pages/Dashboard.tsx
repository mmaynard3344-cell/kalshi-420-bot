import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { useListMarkets } from '@workspace/api-client-react';

import { Layout } from '@/components/Layout';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getTradeToken } from '@/lib/tradeToken';
import { formatPrice } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { summarizePnlCoverage, type PortfolioPnlFill } from '@/lib/portfolioPnl';
import { isBotPnlVerifiedToday } from '@/lib/exchangeCoverage';
import {
  deriveEntryGapPanelState,
  type EntryGapApiResponse,
  type EntryGapRow as Phase4BEntryGapRow,
  type EntryGapBackfillRow as Phase4BEntryGapBackfillRow,
} from '@/lib/entryGapPanel';
import {
  deriveCoveragePanelState,
  describeRecovery,
  type CoverageApiResponse,
} from '@/lib/coveragePanel';
import {
  computeEth30WeekSummary,
  type Eth30TickerRow,
  type Eth30Report,
} from '@/lib/eth30FeeWarning';
import { startTargetLiquidityLoop } from '@/lib/targetLiquidityPoller';
import {
  getActiveRuntimeWatchdogAlerts,
  type RuntimeWatchdogResponse,
} from '@/lib/runtimeWatchdogAlerts';
import { getWeekMonday, groupTickersByWeek, computeEth30WeeklyRunningTotals } from '@/lib/eth30WeekGroup';
import {
  filterProtectiveExitEvidence,
  getMixedEthOwnershipAlert,
  MIXED_ETH_OWNERSHIP_ALERT,
  PROTECTIVE_EXIT_EVIDENCE_SECTION_ID,
  type ProtectiveExitMonitorStatus,
} from '@/lib/mixedEthOwnershipAlert';
import {
  RefreshCw, Clock, TrendingUp, TrendingDown, Minus,
  Bell, BellOff, AlertTriangle, Zap, ChevronDown, ChevronRight,
} from 'lucide-react';
import type { Market } from '@workspace/api-client-react';

const REST_REFRESH_INTERVAL_MS = 5 * 60_000;

// Spot price directly affects order sizing, so refresh it more frequently.
const SPOT_PRICE_REFRESH_INTERVAL_MS = 10_000;
// Fetch immediately on mount, then stay conservative with the rate-limited
// exchange positions endpoint. The latest confirmed state remains visible.
const POSITION_REFRESH_INTERVAL_MS = 30_000;

// Analytics polling intervals.
const ANALYTICS_NORMAL_INTERVAL_MS  = 30_000;
const ANALYTICS_ROLLOVER_INTERVAL_MS = 5_000;
// Within this window around Eastern midnight, use the fast interval.
const ROLLOVER_WINDOW_MS = 60_000;

/**
 * Returns milliseconds until the next Eastern midnight (America/New_York).
 * Used to tighten the analytics poll interval around the day-rollover boundary
 * so the Today's P&L card picks up the reset within ≤5 s instead of ≤30 s.
 */
function msUntilEasternMidnight(): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const h = get('hour'), m = get('minute'), s = get('second');
  const secondsElapsed = h * 3600 + m * 60 + s;
  const secondsUntilMidnight = 86400 - secondsElapsed;
  // Subtract the sub-second portion so we don't overshoot by up to 1 s.
  return secondsUntilMidnight * 1000 - now.getMilliseconds();
}

/** Compute the polling delay for analytics: 5 s near midnight, 30 s otherwise. */
function analyticsPollingInterval(): number {
  const ms = msUntilEasternMidnight();
  // Fast-poll in the 60 s window before midnight and the 60 s window after.
  if (ms <= ROLLOVER_WINDOW_MS || ms >= 86_400_000 - ROLLOVER_WINDOW_MS) {
    return ANALYTICS_ROLLOVER_INTERVAL_MS;
  }
  return ANALYTICS_NORMAL_INTERVAL_MS;
}

// Fallback defaults — used until /api/trade/status responds on mount.
const DEFAULT_ALERT_MIN = 90;
const DEFAULT_ALERT_MAX = 95;
const DEFAULT_TIME_ALERT_SECONDS = 120;

function formatSignedUsd(value: number): string {
  const absoluteValue = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return `${value >= 0 ? '+' : '-'}$${absoluteValue}`;
}

// Local extension of the generated Market type to capture floor_strike,
// which is present in some market responses but absent from the generated schema.
interface MarketWithStrike extends Market {
  floor_strike?: number;
}

interface LivePosition {
  ticker: string;
  position_fp: string;
  market_exposure_dollars?: string;
  yes_bid?: number;
  no_bid?: number;
}

interface PositionSnapshot {
  positions: LivePosition[] | null;
  stale: boolean;
}

function useOpenPositions(): PositionSnapshot {
  const [positions, setPositions] = useState<LivePosition[] | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const token = await getTradeToken();
        const response = await fetch('/api/trade/positions', {
          cache: 'no-store',
          credentials: 'include',
          headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (!response.ok) throw new Error(`Position request failed with ${response.status}`);
        const data = (await response.json()) as { market_positions?: LivePosition[]; stale?: boolean };
        if (!alive) return;
        setPositions((data.market_positions ?? []).filter((position) => {
          const quantity = Number(position.position_fp);
          return Number.isFinite(quantity) && quantity !== 0;
        }));
        // The server serves the last known snapshot marked stale while Kalshi
        // is rate-limiting; surface that instead of treating it as fresh.
        setStale(Boolean(data.stale));
      } catch {
        // A failed poll must not turn a known held position into "no position".
        // Keep the last confirmed snapshot and label it stale instead.
        if (alive) setStale(true);
      }
    };

    void refresh();
    const id = setInterval(refresh, POSITION_REFRESH_INTERVAL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { positions, stale };
}

function spread(price: number | null | undefined, alertMin = DEFAULT_ALERT_MIN, alertMax = DEFAULT_ALERT_MAX): { value: number; label: string; inZone: boolean } | null {
  if (price == null) return null;
  if (price >= alertMin && price <= alertMax) return { value: 0, inZone: true, label: 'IN ZONE' };
  if (price < alertMin) return { value: alertMin - price, inZone: false, label: `+${alertMin - price}¢ to beat` };
  return { value: price - alertMax, inZone: false, label: `${price - alertMax}¢ above zone` };
}

/** Format a duration in seconds as M:SS, e.g. 120 → "2:00", 90 → "1:30". */
function fmtWindowTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => ctx.close();
  } catch {
    // AudioContext not available (e.g. server-side)
  }
}

// ─── Notification permission ──────────────────────────────────────────────────

function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );

  const request = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setPermission(result);
  }, []);

  return { permission, request };
}

function sendNotification(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/favicon.ico' });
  } catch {
    // Swallow — notifications blocked silently in some contexts
  }
}

// ─── Countdown ────────────────────────────────────────────────────────────────

interface CountdownState {
  display: string;
  secondsLeft: number | null;
}

function useCountdown(closeTime: string | null | undefined): CountdownState {
  const [state, setState] = useState<CountdownState>({ display: '', secondsLeft: null });
  useEffect(() => {
    if (!closeTime) return;
    const tick = () => {
      const diff = new Date(closeTime).getTime() - Date.now();
      if (diff <= 0) {
        setState({ display: 'CLOSED', secondsLeft: 0 });
        return;
      }
      const totalSeconds = Math.floor(diff / 1000);
      const m = Math.floor(totalSeconds / 60);
      const s = totalSeconds % 60;
      setState({ display: `${m}:${s.toString().padStart(2, '0')}`, secondsLeft: totalSeconds });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [closeTime]);
  return state;
}

// ─── Live crypto prices ───────────────────────────────────────────────────────

interface LivePrices {
  btc: number;
  eth: number;
  sol?: number;
}

function usePrices() {
  const [prices, setPrices] =
    useState<LivePrices | null>(null);

  useEffect(() => {
    let alive = true;

    const fetchPrices = async () => {
      try {
        const response = await fetch('/api/prices', {
          cache: 'no-store',
        });

        if (!response.ok) {
          throw new Error(
            `Price request failed with ${response.status}`,
          );
        }

        const data = (await response.json()) as LivePrices;

        if (
          !Number.isFinite(data.btc) ||
          !Number.isFinite(data.eth)
        ) {
          throw new Error('Invalid spot-price response');
        }
        // sol is optional — do not fail if the server omits it

        if (alive) {
          setPrices(data);
        }
      } catch (error) {
        console.error('Unable to refresh spot prices:', error);
      }
    };

    void fetchPrices();

    const intervalId = setInterval(
      fetchPrices,
      SPOT_PRICE_REFRESH_INTERVAL_MS,
    );

    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, []);

  return prices;
}

// ─── Live market stream (SSE → Kalshi WS) ────────────────────────────────────

type StreamMarket = Record<string, unknown>;

function useMarketStream() {
  const [streamData, setStreamData] = useState<Record<string, StreamMarket>>({});
  const [connected, setConnected] = useState(false);
  const [sseIncidents, setSseIncidents] = useState<ProtectiveExitMonitorIncident[]>([]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1_000;
    // Latest trade price per ticker seen before that ticker's first stream
    // entry exists — applied when the first ticker tick creates the card.
    const pendingTrades: Record<string, number> = {};

    const connect = () => {
      es = new EventSource('/api/stream');

      es.onopen = () => { setConnected(true); retryDelay = 1_000; };

      es.onmessage = (e: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(e.data) as {
            type: string;
            market?: StreamMarket;
            live?: boolean;
            ticker?: string;
            last_price?: number;
            incident?: ProtectiveExitMonitorIncident;
          };
          if (payload.type === 'connected') {
            setConnected(payload.live ?? false);
          } else if (payload.type === 'ticker' && payload.market) {
            const m = payload.market;
            // Kalshi's WS ticker channel only carries YES-side prices; derive
            // the NO side from the complement (binary market: NO bid = 100 − YES ask).
            if (m.no_bid == null && typeof m.yes_ask === 'number') m.no_bid = 100 - m.yes_ask;
            if (m.no_ask == null && typeof m.yes_bid === 'number') m.no_ask = 100 - m.yes_bid;
            const ticker = (m['ticker'] ?? m['market_ticker']) as string | undefined;
            if (ticker) {
              // Apply a trade buffered before this ticker's first tick so
              // 'Last' is fresh as soon as the card renders. Prefer the
              // tick's own last_price when it carries one (it's newer).
              const buffered = pendingTrades[ticker];
              if (buffered != null) {
                if (m.last_price == null) m.last_price = buffered;
                delete pendingTrades[ticker];
              }
              setStreamData((prev) => ({ ...prev, [ticker]: m }));
            }
          } else if (payload.type === 'trade' && payload.ticker && typeof payload.last_price === 'number') {
            // Real-time last-trade price — display-only. Merge into the
            // existing stream entry so 'Last' stays fresh between snapshots.
            const { ticker, last_price } = payload;
            setStreamData((prev) => {
              const existing = prev[ticker];
              if (!existing) {
                // No market card yet — buffer the latest trade so it can be
                // applied when the first ticker tick arrives.
                pendingTrades[ticker] = last_price;
                return prev;
              }
              return { ...prev, [ticker]: { ...existing, last_price } };
            });
          } else if (payload.type === 'pe_monitor_incident' && payload.incident) {
            const incident = payload.incident;
            // Prepend the new incident immediately — no poll wait.
            setSseIncidents((prev) => {
              if (prev.some((p) => p.id === incident.id)) return prev;
              return [incident, ...prev];
            });
            // Fire a browser Notification so the alert is visible even when
            // the tab is in the background.
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              try {
                new Notification('⚠️ Exit monitor incident', {
                  body: `${incident.ticker} — ${incident.kind}: ${incident.details.slice(0, 120)}`,
                  tag: `pe-incident-${incident.id}`,
                });
              } catch { /* notification may be blocked */ }
            } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
              // Request permission opportunistically; the user may have already
              // granted it for BBO alerts — this is a no-op if so.
              void Notification.requestPermission();
            }
          }
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 30_000);
          connect();
        }, retryDelay);
      };
    };

    connect();
    return () => { es?.close(); if (retryTimer) clearTimeout(retryTimer); };
  }, []);

  return { streamData, connected, sseIncidents };
}

// ─── Price bar ────────────────────────────────────────────────────────────────

function PriceBar({ yes }: { yes: number | null | undefined }) {
  const y = yes ?? 0;
  const width = Math.max(2, Math.min(98, y));
  return (
    <div className="h-2 w-full rounded-full overflow-hidden bg-muted flex">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${width}%`, background: 'linear-gradient(90deg, hsl(var(--primary)), hsl(var(--chart-2)))' }}
      />
    </div>
  );
}

// ─── Alert log entry ─────────────────────────────────────────────────────────

interface AlertEntry {
  id: string;
  asset: 'BTC' | 'ETH' | 'SOL';
  side: 'YES' | 'NO';
  price: number;
  ticker: string;
  eventTicker: string;
  time: Date;
}

const ALERT_LOG_KEY = 'kalshi-alert-log';
function kalshiUrl(asset: 'BTC' | 'ETH' | 'SOL', eventTicker: string) {
  const series = asset === 'BTC' ? 'KXBTC15M' : asset === 'ETH' ? 'KXETH15M' : 'KXSOL15M';
  return `https://kalshi.com/markets/${series}/${eventTicker}`;
}

// ─── Market panel ─────────────────────────────────────────────────────────────

function MarketPanel({
  asset, market, lastKnownMarket, isLoading, alertsEnabled, triggered, countdown, livePrice,
  alertMin, alertMax, timeAlertSeconds, openPosition, positionsLoaded, positionsStale,
}: {
  asset: 'BTC' | 'ETH' | 'SOL';
  market: Market | undefined;
  lastKnownMarket: Market | undefined;
  isLoading: boolean;
  alertsEnabled: boolean;
  triggered: { yes: boolean; no: boolean };
  countdown: CountdownState;
  livePrice: number | null;
  alertMin: number;
  alertMax: number;
  timeAlertSeconds: number;
  openPosition: LivePosition | null | undefined;
  positionsLoaded: boolean;
  positionsStale: boolean;
}) {
  // During the inter-window gap market is undefined but we have a last-known
  // snapshot — show it dimmed so the dashboard doesn't look broken.
  const isTransitioning = !market && !isLoading && lastKnownMarket != null;
  const displayMarket = market ?? (isTransitioning ? lastKnownMarket : undefined);
  const yesProb =
    displayMarket?.yes_bid != null && displayMarket?.yes_ask != null
      ? (displayMarket.yes_bid + displayMarket.yes_ask) / 2
      : displayMarket?.last_price ?? displayMarket?.yes_bid ?? null;
  const prev = displayMarket?.previous_price ?? null;
  const delta = yesProb !== null && prev !== null ? yesProb - prev : null;

  const TrendIcon = delta === null ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  const trendColor =
    delta === null ? 'text-muted-foreground' :
    delta > 0 ? 'text-chart-3' :
    delta < 0 ? 'text-destructive' : 'text-muted-foreground';

  // Alerts only apply when market is live; silence them during transition
  const isAlertActive = !isTransitioning && (triggered.yes || triggered.no);
  const isTimeCritical = !isTransitioning && countdown.secondsLeft !== null && countdown.secondsLeft <= timeAlertSeconds && countdown.secondsLeft > 0;
  const positionSide = openPosition && Number(openPosition.position_fp) < 0 ? 'NO' : 'YES';
  const positionContracts = openPosition ? Math.abs(Number(openPosition.position_fp)) : null;
  const positionBid = openPosition
    ? positionSide === 'YES' ? openPosition.yes_bid : openPosition.no_bid
    : null;
  const positionExposure = openPosition ? Number(openPosition.market_exposure_dollars) : null;

  return (
    <div className={cn(
      'border rounded-xl p-6 bg-card flex flex-col gap-5 transition-all duration-300',
      isAlertActive
        ? 'border-yellow-500/70 shadow-[0_0_24px_4px] shadow-yellow-500/20 animate-pulse-once'
        : isTransitioning
          ? asset === 'BTC' ? 'border-chart-1/20' : asset === 'ETH' ? 'border-chart-2/20' : 'border-chart-4/20'
          : asset === 'BTC' ? 'border-chart-1/40' : asset === 'ETH' ? 'border-chart-2/40' : 'border-chart-4/40',
    )}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn(
            'h-10 w-10 rounded-lg flex items-center justify-center font-bold text-sm',
            isTransitioning
              ? asset === 'BTC' ? 'bg-chart-1/8 text-chart-1/50' : asset === 'ETH' ? 'bg-chart-2/8 text-chart-2/50' : 'bg-chart-4/8 text-chart-4/50'
              : asset === 'BTC' ? 'bg-chart-1/15 text-chart-1' : asset === 'ETH' ? 'bg-chart-2/15 text-chart-2' : 'bg-chart-4/15 text-chart-4',
          )}>
            {asset}
          </div>
          <div>
            <div className={cn('font-semibold text-base', isTransitioning ? 'text-muted-foreground' : 'text-foreground')}>
              {asset === 'BTC' ? 'Bitcoin' : asset === 'ETH' ? 'Ethereum' : 'Solana'} 15-min
            </div>
            <div className="text-xs text-muted-foreground font-mono">{displayMarket?.ticker ?? '—'}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {displayMarket?.event_ticker && (
            <a
              href={kalshiUrl(asset, displayMarket.event_ticker as string)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs font-semibold text-foreground bg-muted border border-border px-2.5 py-1 rounded-full hover:bg-muted/70 transition-colors"
              aria-label={`Trade the current ${asset} 15-minute market on Kalshi`}
            >
              Trade on Kalshi ↗
            </a>
          )}
          {isAlertActive && triggered.yes && (
            <span className="flex items-center gap-1 text-xs font-semibold text-primary bg-primary/10 border border-primary/30 px-2.5 py-1 rounded-full">
              YES
            </span>
          )}
          {isAlertActive && triggered.no && (
            <span className="flex items-center gap-1 text-xs font-semibold text-destructive bg-destructive/10 border border-destructive/30 px-2.5 py-1 rounded-full">
              NO
            </span>
          )}
          {isAlertActive && displayMarket?.event_ticker && (
            <a
              href={kalshiUrl(asset, displayMarket.event_ticker as string)}
              target="_blank"
              rel="noopener noreferrer"
              title="Browser-observed direct BBO bid in zone — server evaluates independently using its own derived ask"
              className="flex items-center gap-1 text-xs font-semibold text-yellow-500 bg-yellow-500/10 border border-yellow-500/30 px-2.5 py-1 rounded-full hover:bg-yellow-500/20 transition-colors"
            >
              <Bell className="h-3 w-3" />
              Quote alert — view market →
            </a>
          )}
          <div className={cn(
            'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full',
            isTransitioning
              ? 'bg-muted/60 text-muted-foreground/70'
              : displayMarket?.status === 'open' ? 'bg-chart-3/10 text-chart-3' : 'bg-muted text-muted-foreground',
          )}>
            <span className={cn(
              'h-1.5 w-1.5 rounded-full',
              isTransitioning
                ? 'bg-muted-foreground/40'
                : displayMarket?.status === 'open' ? 'bg-chart-3 animate-pulse' : 'bg-muted-foreground',
            )} />
            {isTransitioning ? 'AWAITING' : (displayMarket?.status?.toUpperCase() ?? 'LOADING')}
          </div>
        </div>
      </div>

      {/* Question */}
      {displayMarket?.title && (
        <p
          className={cn('text-sm leading-snug border-l-2 pl-3', isTransitioning ? 'text-muted-foreground/50' : 'text-muted-foreground')}
          style={{ borderColor: isTransitioning
            ? asset === 'BTC' ? 'hsl(var(--chart-1) / 0.3)' : asset === 'ETH' ? 'hsl(var(--chart-2) / 0.3)' : 'hsl(var(--chart-4) / 0.3)'
            : asset === 'BTC' ? 'hsl(var(--chart-1))' : asset === 'ETH' ? 'hsl(var(--chart-2))' : 'hsl(var(--chart-4))' }}
        >
          {displayMarket.title}
        </p>
      )}

      {isLoading && !displayMarket ? (
        <LoadingSpinner className="py-4" />
      ) : displayMarket ? (
        <div className={cn('flex flex-col gap-5', isTransitioning && 'opacity-40 pointer-events-none select-none')}>
          {/* Transitioning banner — shown above stale data */}
          {isTransitioning && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              Transitioning to next window…
            </div>
          )}

          {/* Exchange-confirmed live position — exact ticker only, never inferred from fills. */}
          <div className={cn(
            'rounded-lg border px-3 py-2.5',
            openPosition
              ? positionSide === 'YES'
                ? 'border-primary/30 bg-primary/5'
                : 'border-destructive/30 bg-destructive/5'
              : 'border-border bg-muted/20',
            positionsStale && 'opacity-70',
          )}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn(
                  'text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5',
                  openPosition
                    ? positionSide === 'YES' ? 'bg-primary/15 text-primary' : 'bg-destructive/15 text-destructive'
                    : 'bg-muted text-muted-foreground',
                )}>
                  {openPosition ? 'Open trade' : positionsLoaded ? 'No open trade' : positionsStale ? 'Position unavailable' : 'Checking position'}
                </span>
                {openPosition && (
                  <span className="text-sm font-semibold text-foreground">
                    {positionSide} · {positionContracts?.toLocaleString('en-US', { maximumFractionDigits: 2 })} contracts
                  </span>
                )}
              </div>
              {positionsStale ? (
                <span className="text-[10px] text-amber-500 shrink-0">last confirmed snapshot</span>
              ) : openPosition ? (
                <span className="text-[10px] text-chart-3 shrink-0">exchange confirmed</span>
              ) : null}
            </div>
            {openPosition && (
              <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                <span>Bid {positionBid != null ? `${positionBid}¢` : '—'}</span>
                <span>Exposure {Number.isFinite(positionExposure) ? `$${Math.abs(positionExposure!).toFixed(2)}` : '—'}</span>
              </div>
            )}
          </div>

          {/* Probability bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground font-medium">
              <span>Estimated YES probability</span>
              <span className="font-mono">{yesProb !== null ? `${yesProb.toFixed(1)}%` : '—'}</span>
            </div>
            <PriceBar yes={yesProb} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>YES</span><span>NO</span>
            </div>
          </div>

          {/* Now / To beat / Spread */}
          {(() => {
            const floorStrike: number | null = (displayMarket as MarketWithStrike).floor_strike ?? null;
            const priceDiff = livePrice !== null && floorStrike !== null ? livePrice - floorStrike : null;
            const fmtUsd = (n: number | null | undefined) =>
              n != null ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
            return (floorStrike !== null || livePrice !== null) ? (
              <div className="grid grid-cols-3 gap-2 text-center bg-muted/20 rounded-lg px-3 py-2.5">
                <div>
                  <div className="text-xs text-muted-foreground mb-0.5">Now</div>
                  <div className="font-mono font-semibold text-sm text-foreground">
                    {livePrice !== null ? fmtUsd(livePrice) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-0.5">To Beat</div>
                  <div className="font-mono font-semibold text-sm text-foreground">
                    {floorStrike !== null ? fmtUsd(floorStrike) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-0.5">Spread</div>
                  <div className={cn(
                    'font-mono font-semibold text-sm',
                    priceDiff === null ? 'text-muted-foreground' :
                    priceDiff > 0 ? 'text-chart-3' : 'text-destructive',
                  )}>
                    {priceDiff !== null
                      ? `${priceDiff >= 0 ? '+' : ''}${fmtUsd(priceDiff)}`
                      : '—'}
                  </div>
                </div>
              </div>
            ) : null;
          })()}

          {/* Prices */}
          <div className="grid grid-cols-2 gap-3">
            {/* YES */}
            <div className={cn(
              'border rounded-lg p-3 transition-colors',
              triggered.yes && !isTransitioning ? 'bg-yellow-500/10 border-yellow-500/40' : 'bg-primary/5 border-primary/15',
            )}>
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                YES Direct BBO Bid / Ask
                {triggered.yes && !isTransitioning && <AlertTriangle className="h-3 w-3 text-yellow-500" />}
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className={cn('text-2xl font-mono font-bold', triggered.yes && !isTransitioning ? 'text-yellow-500' : 'text-primary')}>
                  {formatPrice(displayMarket.yes_bid)}
                </span>
                <span className={cn('text-base font-mono', triggered.yes && !isTransitioning ? 'text-yellow-500/60' : 'text-primary/60')}>
                  / {formatPrice(displayMarket.yes_ask)}
                </span>
              </div>
            </div>

            {/* NO */}
            <div className={cn(
              'border rounded-lg p-3 transition-colors',
              triggered.no && !isTransitioning ? 'bg-yellow-500/10 border-yellow-500/40' : 'bg-destructive/5 border-destructive/15',
            )}>
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                NO Direct BBO Bid / Ask
                {triggered.no && !isTransitioning && <AlertTriangle className="h-3 w-3 text-yellow-500" />}
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className={cn('text-2xl font-mono font-bold', triggered.no && !isTransitioning ? 'text-yellow-500' : 'text-destructive')}>
                  {formatPrice(displayMarket.no_bid)}
                </span>
                <span className={cn('text-base font-mono', triggered.no && !isTransitioning ? 'text-yellow-500/60' : 'text-destructive/60')}>
                  / {formatPrice(displayMarket.no_ask)}
                </span>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-muted/40 rounded-lg p-2.5">
              <div className="text-xs text-muted-foreground mb-0.5">Last</div>
              <div className="font-mono font-semibold text-sm text-foreground">{formatPrice(displayMarket.last_price)}</div>
            </div>
            <div className="bg-muted/40 rounded-lg p-2.5">
              <div className="text-xs text-muted-foreground mb-0.5">Change</div>
              <div className={cn('font-mono font-semibold text-sm flex items-center justify-center gap-0.5', trendColor)}>
                <TrendIcon className="h-3 w-3" />
                {delta !== null ? `${delta > 0 ? '+' : ''}${delta}¢` : '—'}
              </div>
            </div>
            <div className="bg-muted/40 rounded-lg p-2.5">
              <div className="text-xs text-muted-foreground mb-0.5">Volume</div>
              <div className="font-mono font-semibold text-sm text-foreground">
                {displayMarket.volume != null
                  ? displayMarket.volume >= 1000 ? `${(displayMarket.volume / 1000).toFixed(1)}K` : displayMarket.volume
                  : '—'}
              </div>
            </div>
          </div>

          {/* Alert threshold indicator — hidden during transition */}
          {alertsEnabled && !isTransitioning && (
            <div className="flex items-center justify-between text-xs bg-muted/30 rounded-lg px-3 py-2">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Bell className="h-3 w-3" />
                Direct BBO bid alert · {alertMin}¢ – {alertMax}¢ · last {fmtWindowTime(timeAlertSeconds)}
              </span>
              <span className={cn(
                'font-mono font-medium',
                isAlertActive ? 'text-yellow-500' : 'text-muted-foreground',
              )}>
                {isAlertActive ? 'QUOTE ALERT' : 'watching quotes'}
              </span>
            </div>
          )}

          {/* Countdown — hidden during transition (window is already closed) */}
          {!isTransitioning && (
            <div className={cn(
              'flex items-center justify-between pt-1 border-t',
              isTimeCritical ? 'border-yellow-500/40' : 'border-border',
            )}>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className={cn('h-3.5 w-3.5', isTimeCritical && 'text-yellow-500')} />
                <span className={isTimeCritical ? 'text-yellow-500 font-medium' : ''}>Closes in</span>
              </div>
              <div className={cn(
                'font-mono font-bold text-sm tabular-nums',
                countdown.display === 'CLOSED' ? 'text-destructive' :
                isTimeCritical ? 'text-yellow-500 animate-pulse' : 'text-foreground',
              )}>
                {countdown.display || '—'}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="py-4 text-center text-sm text-muted-foreground">No active market</div>
      )}
    </div>
  );
}

interface OrderSimResult {
  analyticsId:               string;
  clientOrderId:             string;
  ticker:                    string;
  side:                      'yes' | 'no';
  limitCents:                number;
  submittedAtMs:             number;
  iocFillCount:              number;
  hasL2Snapshot:             boolean;
  missClassification:        'no_depth' | 'price_too_low' | 'partial_depth' | 'unknown';
  hasTicks:                  boolean;
  totalTicksInWindow:        number;
  inZoneTicksInRestingWindow: number;
  inZoneFraction:            number;
  restingFillLikelihood:     'high' | 'medium' | 'low' | 'zero' | 'unknown';
  estimatedFillPriceCents:   number | null;
  summary:                   string;
  l2AtSubmission: {
    depthAtOrBetterDollars:   number;
    depthAtOrBetterContracts: number;
    lowestLevelCents:         number | null;
    totalLevels:              number;
    fetchLatencyMs:           number;
    error:                    string | null;
  } | null;
}
interface SeriesStat {
  orderSubmissions:       number;
  successfulFills:        number;
  zeroFills:              number;
  fillRateByOrderAttempt: number | null;
  filledNotionalDollars:  number;
  feesDollars:            number;
  netPnlDollars:          number;
  winsCount:              number;
  lossesCount:            number;
  winRate:                number | null;
  avgActualFillPriceCents: number | null;
  windowsEnteringZone:    number;
  windowsObserved:        number;
}

interface PnlByAsset {
  asset:           string;
  fills:           number;
  wins:            number;
  losses:          number;
  winRate:         number | null;
  grossPnlDollars: number | null;
  netPnlDollars:   number | null;
}

interface DailySummaryVerified {
  /** Authoritative net P&L from the order_fills child-chunk ledger. Null = not yet safe to display (pending verification). */
  netPnlDollars:            number | null;

  settledFillCount:         number;
  /** Settled orders still awaiting verified Kalshi fill chunks. */

  pendingVerificationCount: number;
  /** Fills excluded because fee reconciliation permanently failed. */

  unverifiedFillCount:      number;
  /**
   * True once the exchange-history discovery sweep has completed for today.
   * False means the sweep has not yet finished — the daily total may be
   * incomplete because exchange-side fills could still be discovered.
   * Absent on older server versions that do not run the sweep.
   */

  bySeries?: Array<{
    series: string;
    netPnlDollars: number | null;
    settledFillCount: number;
    pendingVerificationCount: number;
    unverifiedFillCount: number;

  }>;

  exchangeReconciliationComplete?: boolean;
}
interface DailySummaryData {
  date:     string;
  btc:      SeriesStat;
  eth:      SeriesStat;
  combined: SeriesStat;
  /**
   * Authoritative fill-ledger P&L — same data source as the "Settled P&L today" strip.
   * Present when the server has DB access; absent on older server versions.
   */
  verified?: DailySummaryVerified;
}

interface ExchangeHistoryFill extends PortfolioPnlFill {
  created_time?: string;
}

interface AccountSettledPnl {
  realizedPnl: number | null;
  settledFillCount: number;
  pendingSettlementCount: number;
}

function easternDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

interface AnalyticsWindow {
  ticker:                  string;
  series:                  string | null;
  closeTime:               string | null;
  firstSeenMs:             number | null;
  entered:                 boolean;
  inZone:                  boolean;
  outcome:                 string | null;
  side:                    string | null;
  priceCents:              number | null;
  contractsFilled:         number | null;
  spentDollars:            number | null;
  skipReason:              string | null;
  settlementResult:        string | null;
  submittedOrders:         number;
  zeroFills:               number;
  partialFills:            number;
  fullFills:               number;
  attemptNumberThatFilled: number | null;
  totalSpendDollars:       number;
  totalFeesDollars:        number;
  analyticsResult:         string | null;
  /** Server's first in-zone derived YES ask (100 − noBid), set by wlTick. Null if server never entered. */
  yesDerivedAsk:           number | null | undefined;
  /** Server's first in-zone derived NO ask (100 − yesBid), set by wlTick. Null if server never entered. */
  noDerivedAsk:            number | null | undefined;
}

interface SubmissionAudit {
  stage: string;
  reason: string | null;
  recordedAtMs: number;
  postInitiated: boolean;
  responseReceived: boolean;
  originalExecutablePriceCents?: number | null;
  finalExecutablePriceCents?: number | null;
  finalQuoteAgeMs?: number | null;
  finalPriceDeltaCents?: number | null;
  httpStatus?: number | null;
  providerMessage?: string | null;
  postDurationMs?: number | null;
}

interface AnalyticsOrderAttempt {
  ticker: string;
  clientOrderId: string;
  outcome: string;
  submissionAudit?: SubmissionAudit | null;
}

interface ProtectiveExitAudit {
  id: string;
  timestampMs: number;
  ticker: string;
  asset: 'BTC' | 'ETH';
  heldSide: 'yes' | 'no';
  originalEntryPriceCents: number | null;
  triggerCents: number;
  executableBidCents: number | null;
  limitPriceCents: number;
  fillQuantity: number | null;
  averageExitPriceCents: number | null;
  confirmedPositionBefore: number;
  remainingPosition: number | null;
  outcome: string;
  reason: string | null;
}

/** High-severity incident: confirmed local entry the exit monitor could not
 * verify against the exchange while at/below (or possibly below) the 80¢ floor. */
interface ProtectiveExitMonitorIncident {
  id: string;
  ticker: string;
  detectedAtMs: number;
  kind: string;
  severity: 'high';
  localSide: 'yes' | 'no' | null;
  localQuantity: number | null;
  executableBidCents: number | null;
  details: string;
  /** Null = unacknowledged; epoch ms when an operator marked it reviewed. */
  acknowledgedAt: number | null;
}

// ─── P&L by price band ────────────────────────────────────────────────────────

interface PnlBand {
  band:            string;
  minCents:        number;
  maxCents:        number;
  fills:           number;
  wins:            number;
  losses:          number;
  winRate:         number | null;
  netPnlDollars:   number | null;
  roi:             number | null;
  sampleWarning:   string | null;
}

interface TimeOfDayStats {
  fills:         number;
  wins:          number;
  losses:        number;
  winRate:       number | null;
  netPnlDollars: number | null;
  roi:           number | null;
  sampleWarning: string | null;
}

interface PnlByTimeOfDay {
  label:    string;
  minHour:  number;
  maxHour:  number;
  combined: TimeOfDayStats;
  btc:      TimeOfDayStats;
  eth:      TimeOfDayStats;
}

interface PnlReport {
  period:      string;
  /** All outcome-reconciled fills in the selected P&L period. */
  summary:     PnlByAsset;
  byBand:      PnlBand[];
  byAsset:     PnlByAsset[];
  byTimeOfDay?: PnlByTimeOfDay[];
  pending: { fillsTotal: number; fillsPending: number };
  /** Number of settled fills that used an estimated fill price (reconciliation permanently failed). */
  estimatedFillCount?: number;
  /**
   * Whether the report total has been confirmed against the Kalshi fills API.
   * "exchange_reconciled" — every fill carries positive confirmation (fill_price_source='actual').
   * "reconstructed"       — at least one fill is estimated, in-flight, or pending settlement.
   */
  reconciliationStatus?: "exchange_reconciled" | "reconstructed";
  /** Per-fill reconciliation breakdown. */
  reconciliation?: {
    status:               "exchange_reconciled" | "reconstructed";
    totalFills:           number;
    exchangeVerified:     number;
    estimatedPrice:       number;
    pendingReconciliation: number;
    pendingSettlement:    number;
    verifiedNetPnlDollars:   number | null;
    estimatedNetPnlDollars:  number | null;
    reportedNetPnlDollars:   number | null;
  };
  /** Verified child-fill totals for this report period. */
  verified?: {
    bySeries: Array<{
      series: string;
      realizedNetPnlDollars: number | null;
      settledFillCount: number;
      pendingVerificationCount: number;
      unverifiedFillCount: number;
    }>;
    combined: {
      realizedNetPnlDollars: number | null;
      settledFillCount: number;
      pendingVerificationCount: number;
      unverifiedFillCount: number;
    };
  };
}

// ─── Mandelbrot research-only report ─────────────────────────────────────────

interface MandelbrotBucket {
  label: string;
  sampleCount: number;
  filledCount: number;
  reconciledFillCount: number;
  winRate: number | null;
  netPnlDollars: number | null;
  fallingKnifeRate: number | null;
  hasUnreconciledFills: boolean;
}

interface MandelbrotCaptureStatus {
  enabled: boolean;
  successfulWrites: number;
  failedWrites: number;
  queueDrops: number;
  queueDepth: number;
  lastError: string | null;
}

interface MandelbrotReport {
  captureEnabled: boolean;
  observationCount: number;
  totalFills: number;
  totalReconciledFills: number;
  reconciliationCompleteness: number | null;
  spreadQualityCounts: { bbo_derived: number; l2_snapshot: number; unavailable: number };
  buckets: MandelbrotBucket[];
  captureStatus: MandelbrotCaptureStatus;
}

// Eth30TickerRow and Eth30Report are imported from @/lib/eth30FeeWarning below.

// ── Target-liquidity report types (mirrors targetLiquidity.ts shapes) ──────────

type TargetLiquidityClassification =
  | 'no_position'
  | 'target_filled'
  | 'never_reached_target'
  | 'reached_target_no_depth_data'
  | 'insufficient_depth'
  | 'sufficient_depth_unfilled';

interface TargetLiquidityPositionReport {
  ticker:                      string;
  easternDate:                 string;
  side:                        'yes' | 'no' | null;
  classification:              TargetLiquidityClassification;
  entryContracts:              number;
  exitContracts:               number;
  openContracts:               number;
  settled:                     boolean;
  firstExecutableAtMs:         number | null;
  snapshotCount:               number;
  usableSnapshotCount:         number;
  firstSnapshotAtMs:           number | null;
  lastSnapshotAtMs:            number | null;
  maxContractsAtOrAboveTarget: number | null;
  lastRestingContracts:        number | null;
  lastOrderStatus:             string | null;
  targetKalshiOrderId:         string | null;
  targetPlacedAtMs:            number | null;
  sufficientDepthSnapshots:    number;
}

interface TargetLiquidityReport {
  strategy:      string;
  targetCents:   number;
  generatedAtMs: number;
  positions:     TargetLiquidityPositionReport[];
  summary: {
    positions:               number;
    targetFilled:            number;
    neverReachedTarget:      number;
    reachedNoDepthData:      number;
    insufficientDepth:       number;
    sufficientDepthUnfilled: number;
  };
}

type Eth2125DepthClassification = 'depth_confirmed' | 'insufficient_depth' | 'bbo_touch_only' | 'not_reached';

interface Eth2125DepthAudit {
  classification: Eth2125DepthClassification;
  snapshotCount: number;
  usableSnapshotCount: number;
  maxContractsAtOrAboveTarget: number | null;
  depthConfirmed: boolean;
}

interface Eth2125ProspectiveReport {
  researchOnly: true;
  tradingCapability: 'none';
  cohortStartMs: number;
  reviewGateTrades: number;
  benchmark: { trades: number; wins: number; losses: number; targetHitRate: number; netPnlCents: number; maxDrawdownCents: number };
  summary: {
    eligibleTrades: number; targetHits: number; targetHitRate: number | null;
    wins: number; losses: number; grossPnlCents: number; feesCents: number;
    netPnlCents: number; averageWinnerCents: number | null; averageLoserCents: number | null;
    maxDrawdownCents: number; reviewReady: boolean; openTrades: number;
    targetHitsDepthConfirmed: number;
    targetHitsInsufficientDepth: number;
    targetHitsBboTouchOnly: number;
    reviewEvidenceComplete: boolean;
  };
  rows: Array<{
    ticker: string; side: 'yes' | 'no'; entryPriceCents: number; contracts: number;
    targetReachedAtMs: number | null; settlementResult: 'yes' | 'no' | null;
    grossPnlCents: number | null; feeCents: number; netPnlCents: number | null;
    cumulativeNetPnlCents: number; depthAudit: Eth2125DepthAudit;
  }>;
}

interface TradeStatus {
  trading_halted:           boolean;

  environment_lock:         boolean;

  bet_dollars_btc:          number;

  bet_dollars_eth:          number;

  alert_min:                number;

  alert_max:                number;

  time_alert_seconds:       number;

  spent_cents:              number;

  max_daily_notional_cents: number;

  remaining_cents:          number;

  daily_realized_net_pnl_dollars: number | null;
  kalshi_daily_realized_pnl?: {
    realizedPnlDollars: number | null;
    retrievedAt: string | null;
    state: 'below_target' | 'target_reached' | 'unavailable';
    reason?: string;
  };
  daily_profit_target_dollars?: number;
  /** Settled orders whose authoritative Kalshi fill ledger has not arrived yet. */

  daily_realized_pending_fill_count?: number;
  /** Fills excluded from the net P&L because fee reconciliation permanently failed. */

  daily_realized_unverified_fill_count?: number;
  /**
   * True once the exchange-history discovery sweep completed for today.
   * False means the sweep hasn't finished — the total may still be incomplete.
   * Absent on older server versions.
   */

  exchange_history_coverage?: {
    checkedAt: string | null;
    unmatchedOrderCount: number | null;
    /** False when the bounded check stopped before all exchange pages were read. */
    complete?: boolean | null;
    truncated?: boolean;
    lastError: string | null;
  };

  orphanedFillLinks?: {
    count: number;
    checkedAt: string | null;
  };

  exchange_reconciliation_complete?: boolean;
}

type BoundaryDiscoveryStage =
  | 'upcoming_seen'
  | 'probe_started'
  | 'active_response'
  | 'usable_metadata'
  | 'rollover'
  | 'evaluation_started'
  | 'reservation'
  | 'exchange_submission'
  | 'executor_blocked'
  | 'probe_deferred'
  | 'probe_exhausted';

interface BoundaryDiscoveryEvent {
  ticker: string;
  openTimeMs: number;
  atMs: number;
  stage: BoundaryDiscoveryStage;
  reason: string | null;
}

interface BoundaryDiscoveryTimeline {
  ticker: string;
  openTimeMs: number;
  events: BoundaryDiscoveryEvent[];
  metadataState: 'not_applicable' | 'unavailable' | 'usable';
}

interface BoundaryDiscoveryReport {
  available: boolean;
  timelines: BoundaryDiscoveryTimeline[];
}

const BOUNDARY_TIMELINE_STAGES: Array<{ stage: BoundaryDiscoveryStage; label: string }> = [
  { stage: 'upcoming_seen', label: 'Discovery' },
  { stage: 'active_response', label: 'Fresh response' },
  { stage: 'evaluation_started', label: 'Evaluation' },
  { stage: 'reservation', label: 'Reservation' },
  { stage: 'exchange_submission', label: 'Submission' },
];

function boundaryStageLabel(stage: BoundaryDiscoveryStage): string {
  return BOUNDARY_TIMELINE_STAGES.find((item) => item.stage === stage)?.label
    ?? stage.replaceAll('_', ' ');
}

// ─── Evaluation event (server-side per-tick decision log) ────────────────────

type EvaluationOutcome =
  | 'no_tick'
  | 'out_of_zone'
  | 'incoherent_bbo_snapshot'
  | 'wide_spread'
  | 'preflight_skip'
  | 'forwarded'
  | 'place_order_rejected'
  /** Kalshi definitively rejected: HTTP 400/404/422 or 2xx body with rejectReason. */
  | 'exchange_rejected'
  /** POST sent but outcome uncertain — network timeout, connection reset, etc. */
  | 'post_unknown';

interface EvaluationEvent {
  ticker:            string;
  series:            string;
  timestampMs:       number;
  secondsLeft:       number;
  source:            'websocket' | 'rest_fallback' | 'startup_prime';
  yesBid:            number | null;
  yesAsk:            number | null;
  noBid:             number | null;
  noAsk:             number | null;
  yesDerivedAsk:     number | null;
  noDerivedAsk:      number | null;
  side:              'yes' | 'no' | null;
  limitCents:        number | null;
  outcome:           EvaluationOutcome;
  preflightDecision: string | null;
  /** Fresh selected-side executable L2 price, when the event reached preflight. */
  freshExecutablePriceCents?: number | null;
  /** BBO-derived ceiling that the preflight gate was authorized to use. */
  authorizedLimitCents?: number | null;
}

const EVAL_OUTCOME_LABEL: Record<EvaluationOutcome, string> = {
  no_tick:                'no tick (no BBO)',
  out_of_zone:            'out of zone',
  incoherent_bbo_snapshot:'incoherent BBO',
  wide_spread:            'wide spread',
  preflight_skip:         'preflight skip',
  forwarded:              'handed to place-order',
  place_order_rejected:   'rejected in place-order',
  exchange_rejected:      'exchange rejected',
  post_unknown:           'outcome unknown (post sent)',
};

function evalOutcomeColor(outcome: EvaluationOutcome): string {
  if (outcome === 'exchange_rejected')       return 'text-destructive';
  if (outcome === 'post_unknown')            return 'text-amber-500';
  if (outcome === 'place_order_rejected')    return 'text-destructive';
  if (outcome === 'forwarded')               return 'text-chart-2';
  if (outcome === 'preflight_skip')          return 'text-amber-500';
  if (outcome === 'wide_spread')             return 'text-amber-500';
  if (outcome === 'incoherent_bbo_snapshot') return 'text-amber-500';
  return 'text-muted-foreground';
}

/**
 * Find the server evaluation event that best explains a browser alert.
 * Mirrors the server-side findNearestEvaluationEvent logic:
 *  1. Exclude events outside windowMs.
 *  2. Prefer events whose side matches the alert side (side=null events are neutral).
 *  3. Prefer terminal outcomes (place_order_rejected, preflight_skip, …) over
 *     the intermediate `forwarded` event so a rejection is never masked.
 *  4. Tie-break by smallest Δt.
 */
const EVAL_OUTCOME_PRIORITY: Record<EvaluationOutcome, number> = {
  exchange_rejected:       0,   // most definitive terminal outcome
  place_order_rejected:    0,
  post_unknown:            1,   // post sent but result uncertain — still beats forwarded
  preflight_skip:          1,
  wide_spread:             1,
  incoherent_bbo_snapshot: 1,
  no_tick:                 2,
  out_of_zone:             2,
  forwarded:               10,  // intermediate — never shown if a terminal event exists
};

function findNearestEvalEvent(
  events:   EvaluationEvent[],
  ticker:   string,
  targetMs: number,
  windowMs: number = 60_000,
  side?:    'yes' | 'no',
): EvaluationEvent | null {
  let best: EvaluationEvent | null = null;
  let bestScore = Infinity;
  for (const e of events) {
    if (e.ticker !== ticker) continue;
    const delta = Math.abs(e.timestampMs - targetMs);
    if (delta > windowMs) continue;
    const sideMismatch = side != null && e.side != null && e.side !== side;
    const sidePenalty  = sideMismatch ? 1e12 : 0;
    const score = sidePenalty + (EVAL_OUTCOME_PRIORITY[e.outcome] ?? 99) * 1e9 + delta;
    if (score < bestScore) { best = e; bestScore = score; }
  }
  return best;
}

function useEvaluationEvents(): EvaluationEvent[] {
  const [events, setEvents] = useState<EvaluationEvent[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        // 48 h window — matches the localStorage alert log retention so retained
    // alerts always resolve to a server decision even after a page reload.
    const token = await getTradeToken();
    const r = await fetch('/api/trade/analytics/evaluation-events?limitMs=172800000', {
      cache: 'no-store',
      headers: token ? { 'X-Trade-Token': token } : undefined,
    });
        if (r.ok && alive) {
          const d = (await r.json()) as { events: EvaluationEvent[] };
          setEvents(d.events ?? []);
        }
      } catch { /* non-critical */ }
    };
    void poll();
    // Refresh every 30 s — evaluation events are written in near-real-time
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return events;
}

// ─── AutoTrader health hook ───────────────────────────────────────────────────

interface AutoTraderStatus {
  wsLive:        boolean;
  lastTickMs:    number;
  source:        "websocket" | "rest_fallback";
  currentTicker: string;
}

function useAutoTraderStatus(): AutoTraderStatus | null {
  const [status, setStatus] = useState<AutoTraderStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/trade/autotrader-status', { cache: 'no-store' });
        if (r.ok && alive) setStatus(await r.json() as AutoTraderStatus);
      } catch { /* non-critical */ }
    };
    void poll();
    const id = setInterval(poll, 5_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return status;
}

// ─── Server runtime-watchdog health ───────────────────────────────────────────

function useRuntimeWatchdogStatus(): RuntimeWatchdogResponse | null {
  const [status, setStatus] = useState<RuntimeWatchdogResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const token = await getTradeToken();
        const response = await fetch('/api/trade/runtime-watchdog', {
          cache: 'no-store',
          headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (response.ok && alive) setStatus(await response.json() as RuntimeWatchdogResponse);
      } catch { /* health alert polling must not disrupt market monitoring */ }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return status;
}

function RuntimeWatchdogAlertBanner({ status }: { status: RuntimeWatchdogResponse | null }) {
  const alerts = getActiveRuntimeWatchdogAlerts(status);
  if (alerts.length === 0) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-xl border-2 border-destructive/70 bg-destructive/10 shadow-[0_0_20px_4px] shadow-destructive/20"
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-destructive/30">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
        <div>
          <div className="text-sm font-bold text-destructive">
            SERVER HEALTH ALERT{alerts.length !== 1 ? 'S' : ''} — {alerts.length} ACTIVE
          </div>
          <p className="text-xs text-destructive/80 mt-0.5">
            These are server-reported conditions and clear automatically after the watchdog confirms recovery.
          </p>
        </div>
      </div>
      <div className="divide-y divide-destructive/20">
        {alerts.map((alert) => {
          return (
            <div key={alert.dimension} className="px-4 py-3">
              <div className="text-sm font-semibold text-foreground">{alert.title}</div>
              <p className="text-xs text-muted-foreground mt-0.5">{alert.detail}</p>
              {alert.since && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Active since {new Date(alert.since).toLocaleString([], {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
                  })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Polls the protective-exit monitor incidents endpoint every 30 s and merges
 * any incidents already pushed via SSE so the banner is never stale.
 * Only unacknowledged incidents are fetched; acknowledged ones remain in the
 * DB for audit purposes but are excluded from the banner.
 */
function useProtectiveExitIncidents(
  sseIncidents: ProtectiveExitMonitorIncident[] = [],
): {
  incidents: ProtectiveExitMonitorIncident[];
  acknowledge: (id: string) => void;
  ackError: string | null;
} {
  const [polledIncidents, setPolledIncidents] = useState<ProtectiveExitMonitorIncident[]>([]);
  const [localAcked, setLocalAcked] = useState<Set<string>>(new Set());
  const [ackError, setAckError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(
          '/api/trade/analytics/protective-exit-incidents?limit=20&unacknowledged=true',
          { cache: 'no-store' },
        );
        if (r.ok && alive) {
          const d = (await r.json()) as { incidents: ProtectiveExitMonitorIncident[] };
          setPolledIncidents(d.incidents ?? []);
          // Clear any locally-acked ids that the server no longer returns
          setLocalAcked((prev) => {
            if (prev.size === 0) return prev;
            const serverIds = new Set((d.incidents ?? []).map((i) => i.id));
            const next = new Set([...prev].filter((id) => serverIds.has(id)));
            return next.size === prev.size ? prev : next;
          });
        }
      } catch { /* non-critical */ }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const acknowledge = useCallback(async (id: string) => {
    // Optimistically hide the incident immediately
    setLocalAcked((prev) => new Set([...prev, id]));
    setAckError(null);
    try {
      const token = await getTradeToken();
      const r = await fetch(
        `/api/trade/analytics/protective-exit-incidents/${encodeURIComponent(id)}/acknowledge`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: token ? { 'X-Trade-Token': token } : undefined,
        },
      );
      if (!r.ok) {
        // Roll back the optimistic hide — server rejected the write
        setLocalAcked((prev) => { const next = new Set(prev); next.delete(id); return next; });
        const body = await r.json().catch(() => ({})) as Record<string, unknown>;
        setAckError(String(body['error'] ?? `Server returned ${r.status} — incident not marked reviewed`));
        return;
      }
      // updated: false = row was already acknowledged; keep it hidden, no error
    } catch {
      // Roll back on network failure so the incident reappears
      setLocalAcked((prev) => { const next = new Set(prev); next.delete(id); return next; });
      setAckError('Network error — incident not marked reviewed. Try again.');
    }
  }, []);

  // Merge SSE-pushed incidents with the polled list, then filter acknowledged.
  // SSE incidents arrive first so the banner updates immediately; the poll
  // eventually deduplicates them.
  const incidents = useMemo(() => {
    let merged: ProtectiveExitMonitorIncident[];
    if (sseIncidents.length === 0) {
      merged = polledIncidents;
    } else {
      const seen = new Set(polledIncidents.map((i) => i.id));
      const extra = sseIncidents.filter((i) => !seen.has(i.id));
      merged = extra.length === 0
        ? polledIncidents
        : [...extra, ...polledIncidents].sort((a, b) => b.detectedAtMs - a.detectedAtMs);
    }
    return merged.filter((inc) => !localAcked.has(inc.id));
  }, [polledIncidents, sseIncidents, localAcked]);

  return { incidents, acknowledge, ackError };
}

// ─── Protective-exit monitor incident banner ──────────────────────────────────

function ProtectiveExitMonitorBanner({
  incidents,
  onAcknowledge,
  ackError,
}: {
  incidents: ProtectiveExitMonitorIncident[];
  onAcknowledge: (id: string) => void;
  ackError: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (incidents.length === 0) return null;

  const shown = expanded ? incidents : incidents.slice(0, 3);
  const hasMore = incidents.length > 3;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-xl border-2 border-destructive/70 bg-destructive/10 shadow-[0_0_20px_4px] shadow-destructive/20"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-destructive/30">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-destructive">
            PROTECTIVE-EXIT MONITOR — {incidents.length} HIGH-SEVERITY INCIDENT{incidents.length !== 1 ? 'S' : ''}
          </div>
          <p className="text-xs text-destructive/80 mt-0.5">
            A locally confirmed entry could not be verified against the exchange while at or below the 80¢ floor.
            Operator review required. Mark each incident as reviewed once investigated.
          </p>
        </div>
      </div>

      {/* Incident rows */}
      <div className="divide-y divide-destructive/20">
        {shown.map((inc) => {
          const detectedAt = new Date(inc.detectedAtMs);
          const bidLabel = inc.executableBidCents != null ? `${inc.executableBidCents}¢` : '—';
          const sideLabel = inc.localSide ? inc.localSide.toUpperCase() : '—';
          const qtyLabel = inc.localQuantity != null ? `${inc.localQuantity} contracts` : '—';
          return (
            <div key={inc.id} className="px-4 py-3 grid sm:grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="font-mono font-semibold text-sm text-foreground">{inc.ticker}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-destructive/20 text-destructive border border-destructive/40 px-1.5 py-0.5 rounded">
                    {inc.kind}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-snug">{inc.details}</p>
              </div>
              <div className="flex sm:flex-col gap-x-4 gap-y-0.5 text-xs shrink-0 sm:text-right">
                <div>
                  <span className="text-muted-foreground">Detected </span>
                  <span className="font-mono text-foreground">
                    {detectedAt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Bid at detection </span>
                  <span className="font-mono font-semibold text-destructive">{bidLabel}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Side / qty </span>
                  <span className="font-mono text-foreground">{sideLabel} · {qtyLabel}</span>
                </div>
                <button
                  onClick={() => onAcknowledge(inc.id)}
                  className="mt-1 self-end sm:self-auto text-[11px] font-medium text-destructive/70 hover:text-destructive border border-destructive/30 hover:border-destructive/60 rounded px-2 py-0.5 transition-colors"
                  title="Mark this incident as reviewed — it will be removed from the banner but kept in the audit log"
                >
                  Mark reviewed
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Acknowledge error — shown when a "Mark reviewed" write fails */}
      {ackError && (
        <div className="px-4 py-2 border-t border-destructive/30 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{ackError}</span>
        </div>
      )}

      {/* Show more / less */}
      {hasMore && (
        <div className="px-4 py-2 border-t border-destructive/20">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? 'Show fewer incidents' : `Show ${incidents.length - 3} more incident${incidents.length - 3 !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}
    </div>
  );
}

function MixedEthOwnershipAlert({
  tickers,
  onViewEvidence,
}: {
  tickers: string[];
  onViewEvidence: (ticker: string) => void;
}) {
  const alert = getMixedEthOwnershipAlert({ mixedEthStrategyOwnershipTickers: tickers });
  if (!alert) return null;

  return (
    <div
      role="alert"
      className="rounded-xl border-2 border-destructive/70 bg-destructive/10 px-4 py-3 shadow-[0_0_20px_4px] shadow-destructive/20"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-destructive">
            {MIXED_ETH_OWNERSHIP_ALERT.title}
          </h2>
          <p className="text-xs text-destructive/85 mt-1 leading-snug">
            {MIXED_ETH_OWNERSHIP_ALERT.explanation}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="text-xs font-medium text-muted-foreground">Active tickers:</span>
            {alert.tickers.map((ticker) => (
              <button
                key={ticker}
                type="button"
                onClick={() => onViewEvidence(ticker)}
                className="font-mono text-xs font-semibold text-destructive underline underline-offset-2 hover:opacity-75"
                title={`Filter durable protective-exit evidence to ${ticker}`}
              >
                {ticker}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            {MIXED_ETH_OWNERSHIP_ALERT.selectionHint}
          </p>
        </div>
      </div>
    </div>
  );
}

function useTradeStatus(): TradeStatus | null {
  const [status, setStatus] = useState<TradeStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const token = await getTradeToken();
        const r = await fetch('/api/trade/status', {
          cache: 'no-store',
          headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (r.ok && alive) setStatus(await r.json() as TradeStatus);
      } catch { /* non-critical */ }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return status;
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

// hint: Logic changed on both sides. Requires understanding intent of each change.
export default function Dashboard() {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [alertLog, setAlertLog] = useState<AlertEntry[]>(() => loadAlertLog());

  // ── Trade status & strategy config ────────────────────────────────────────
  const tradeStatus = useTradeStatus();
  // Derive live zone/window values — fall back to compile-time defaults until
  // the first /api/trade/status response arrives so the page is never broken.
  const alertMin         = tradeStatus?.alert_min         ?? DEFAULT_ALERT_MIN;
  const alertMax         = tradeStatus?.alert_max         ?? DEFAULT_ALERT_MAX;
  const timeAlertSeconds = tradeStatus?.time_alert_seconds ?? DEFAULT_TIME_ALERT_SECONDS;

  // ── AutoTrader health ──────────────────────────────────────────────────────
  const autoTraderStatus = useAutoTraderStatus();
  const runtimeWatchdogStatus = useRuntimeWatchdogStatus();

  // ── Live market stream (SSE) ───────────────────────────────────────────────
  // Declared early so sseIncidents is available for useProtectiveExitIncidents.
  // The full streamData / streamConnected values are consumed further below.
  const { streamData, connected: streamConnected, sseIncidents } = useMarketStream();

  // ── Protective-exit monitor incidents ─────────────────────────────────────
  // sseIncidents flows from useMarketStream so any new incident pushed over
  // SSE updates the banner immediately, without waiting for the 30 s poll.
  const { incidents: peIncidents, acknowledge: acknowledgeIncident, ackError: peAckError } = useProtectiveExitIncidents(sseIncidents);

  // ── Evaluation events (server per-tick decision log) ──────────────────────
  const evaluationEvents = useEvaluationEvents();

  // ── Exchange-confirmed open positions ─────────────────────────────────────
  const { positions: openPositions, stale: positionsStale } = useOpenPositions();

  // ── Analytics data ─────────────────────────────────────────────────────────
  const [dailySummary, setDailySummary] = useState<DailySummaryData | null>(null);
  const [analyticsWindows, setAnalyticsWindows] = useState<AnalyticsWindow[]>([]);
  const [attemptsByTicker, setAttemptsByTicker] = useState<Record<string, AnalyticsOrderAttempt[]>>({});
  const [pnlReport, setPnlReport] = useState<PnlReport | null>(null);
  const [accountSettledPnl, setAccountSettledPnl] = useState<AccountSettledPnl | null>(null);
  const [accountFillsStale, setAccountFillsStale] = useState(false);
  const [pnlPeriod, setPnlPeriod] = useState<'today' | '7d' | 'all-time'>('7d');
  const [protectiveExits, setProtectiveExits] = useState<ProtectiveExitAudit[]>([]);
  const [protectiveExitMonitorStatus, setProtectiveExitMonitorStatus] = useState<ProtectiveExitMonitorStatus | null>(null);
  const [protectiveExitEvidenceTicker, setProtectiveExitEvidenceTicker] = useState<string | null>(null);
  const [mandelbrotReport, setMandelbrotReport] = useState<MandelbrotReport | null>(null);
  const [eth30Report, setEth30Report] = useState<Eth30Report | null>(null);
  const [eth2125Prospective, setEth2125Prospective] = useState<Eth2125ProspectiveReport | null>(null);
  const [eth30TargetLiquidity, setEth30TargetLiquidity] = useState<TargetLiquidityReport | null>(null);
  const [sol30TargetLiquidity, setSol30TargetLiquidity] = useState<TargetLiquidityReport | null>(null);
  const [boundaryDiscoveryReport, setBoundaryDiscoveryReport] = useState<BoundaryDiscoveryReport | null>(null);
  const [expandedWindowTickers, setExpandedWindowTickers] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const fetchAnalytics = async () => {
      try {
        const token = await getTradeToken();
        const [dailyRes, windowsRes, ordersRes, exitsRes, monitorStatusRes, boundaryDiscoveryRes, mandelbrotRes, eth30Res, eth2125Res, fillsRes] = await Promise.all([
          fetch('/api/trade/analytics/daily', { cache: 'no-store' }),
          fetch('/api/trade/analytics/windows', { cache: 'no-store' }),
          fetch('/api/trade/analytics/orders?limit=500', { cache: 'no-store' }),
          fetch('/api/trade/analytics/protective-exits?limit=100', { cache: 'no-store' }),
          fetch('/api/trade/analytics/protective-exit-status', { cache: 'no-store' }),
          fetch('/api/trade/analytics/boundary-discovery?limit=24', { cache: 'no-store' }),
          fetch('/api/trade/analytics/reports/mandelbrot-instability', { cache: 'no-store' }),
          fetch('/api/trade/analytics/reports/eth30-50', { cache: 'no-store' }),
          fetch('/api/trade/analytics/reports/eth21-25-passive', { cache: 'no-store' }),
          fetch('/api/trade/fills?limit=1000', {
            cache: 'no-store',
            headers: token ? { 'X-Trade-Token': token } : undefined,
          }),
        ]);
        if (dailyRes.ok && alive) setDailySummary((await dailyRes.json()) as DailySummaryData);
        if (windowsRes.ok && alive) {
          const d = (await windowsRes.json()) as { windows: AnalyticsWindow[] };
          setAnalyticsWindows(d.windows ?? []);
        }
        if (ordersRes.ok && alive) {
          const data = (await ordersRes.json()) as { orders: AnalyticsOrderAttempt[] };
          const grouped: Record<string, AnalyticsOrderAttempt[]> = {};
          for (const order of data.orders ?? []) (grouped[order.ticker] ??= []).push(order);
          setAttemptsByTicker(grouped);
        }
        if (exitsRes.ok && alive) {
          const data = (await exitsRes.json()) as { exits: ProtectiveExitAudit[] };
          setProtectiveExits(data.exits ?? []);
        }
        if (monitorStatusRes.ok && alive) {
          const data = (await monitorStatusRes.json()) as ProtectiveExitMonitorStatus;
          setProtectiveExitMonitorStatus(data);
        }
        if (boundaryDiscoveryRes.ok && alive) {
          setBoundaryDiscoveryReport((await boundaryDiscoveryRes.json()) as BoundaryDiscoveryReport);
        }
        if (mandelbrotRes.ok && alive) setMandelbrotReport((await mandelbrotRes.json()) as MandelbrotReport);
        if (eth30Res.ok && alive) setEth30Report((await eth30Res.json()) as Eth30Report);
        if (eth2125Res.ok && alive) setEth2125Prospective((await eth2125Res.json()) as Eth2125ProspectiveReport);
        if (fillsRes.ok && alive) {
          const data = (await fillsRes.json()) as { fills?: ExchangeHistoryFill[]; stale?: boolean };
          // Server serves the last known fills view marked stale while Kalshi
          // is rate-limiting — surface that instead of presenting it as live.
          setAccountFillsStale(Boolean(data.stale));
          const today = easternDate(new Date());
          const todayFills = (data.fills ?? []).filter((fill) => {
            const created = fill.created_time ? new Date(fill.created_time) : null;
            return created && !Number.isNaN(created.getTime()) && easternDate(created) === today;
          });
          const coverage = summarizePnlCoverage(todayFills);
          setAccountSettledPnl(coverage);
        }
      } catch { /* swallow — analytics are non-critical */ }
    };
    let timerId: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timerId = setTimeout(async () => {
        await fetchAnalytics();
        if (alive) schedule();
      }, analyticsPollingInterval());
    };
    void fetchAnalytics();
    schedule();
    return () => { alive = false; clearTimeout(timerId); };
  }, []);

  const viewProtectiveExitEvidence = useCallback((ticker: string) => {
    setProtectiveExitEvidenceTicker(ticker);
    requestAnimationFrame(() => document.getElementById(PROTECTIVE_EXIT_EVIDENCE_SECTION_ID)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    }));
  }, []);

  // Dedicated target-liquidity polling loop — delegates to the extracted
  // startTargetLiquidityLoop helper so the scheduling logic can be unit-tested
  // without a DOM or React runtime.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stop = startTargetLiquidityLoop({
      fetchFn: (url, init) => fetch(url, init),
      scheduleTimeout: (cb, delay) => {
        const id = setTimeout(cb, delay);
        timers.push(id);
        return id;
      },
      onEth30: (r) => setEth30TargetLiquidity(r as unknown as TargetLiquidityReport),
      onSol30: (r) => setSol30TargetLiquidity(r as unknown as TargetLiquidityReport),
    });
    return () => {
      stop();
      for (const id of timers) clearTimeout(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const fetchPnl = async () => {
      try {
        const res = await fetch(`/api/trade/analytics/reports/pnl?period=${pnlPeriod}`, { cache: 'no-store' });
        if (res.ok && alive) setPnlReport((await res.json()) as PnlReport);
      } catch { /* swallow — P&L panel is non-critical */ }
    };
    let timerId: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timerId = setTimeout(async () => {
        await fetchPnl();
        if (alive) schedule();
      }, analyticsPollingInterval());
    };
    void fetchPnl();
    schedule();
    return () => { alive = false; clearTimeout(timerId); };
  }, [pnlPeriod]);

  // Persist alert log to localStorage on every change.
  // Store `time` as a UTC epoch integer (ms) so the displayed time is
  // correct regardless of what timezone the browser is in when it reloads.
  useEffect(() => {
    try {
      const serialized = alertLog.map((e) => ({ ...e, time: e.time.getTime() }));
      localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(serialized));
    } catch { /* storage quota exceeded or unavailable — non-critical */ }
  }, [alertLog]);

  // Track which ticker+side combos have already fired so we don't repeat
  const firedRef = useRef<Set<string>>(new Set());

  const { permission, request: requestPermission } = useNotificationPermission();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refetchOpts = { query: { refetchInterval: REST_REFRESH_INTERVAL_MS } } as any;

  const { data: btcData, isLoading: btcLoading, dataUpdatedAt: btcUpdated, refetch: refetchBtc } = useListMarkets(
    { series_ticker: 'KXBTC15M', status: 'open', limit: 1 },
    refetchOpts,
  );

  const { data: ethData, isLoading: ethLoading, dataUpdatedAt: ethUpdated, refetch: refetchEth } = useListMarkets(
    { series_ticker: 'KXETH15M', status: 'open', limit: 1 },
    refetchOpts,
  );

  const { data: solData, isLoading: solLoading, dataUpdatedAt: solUpdated, refetch: refetchSol } = useListMarkets(
    { series_ticker: 'KXSOL15M', status: 'open', limit: 1 },
    refetchOpts,
  );

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([refetchBtc(), refetchEth(), refetchSol()]);
    setIsRefreshing(false);
  }, [refetchBtc, refetchEth, refetchSol]);

  const btcPollMarket = btcData?.markets?.[0];
  const ethPollMarket = ethData?.markets?.[0];
  const solPollMarket = solData?.markets?.[0];

  const prices = usePrices();

  // Merge stream bid/ask on top of the full REST market object.
  // WS ticker payloads carry many null fields (last_price, floor_strike, …);
  // only non-null stream values may override the REST snapshot, otherwise the
  // card regresses to dashes for fields REST already provided.
  // Fields that the REST poll owns authoritatively — WS ticker snapshots
  // often carry stale or placeholder values for these (e.g. status:"unknown"),
  // so we never let the stream overwrite them.
  const STREAM_SKIP_FIELDS = new Set(['status']);

  const mergeLive = (poll: Market, live: StreamMarket | undefined): Market => {
    const merged: Record<string, unknown> = { ...(poll as unknown as Record<string, unknown>) };
    if (live) {
      for (const [k, v] of Object.entries(live)) {
        if (v != null && !STREAM_SKIP_FIELDS.has(k)) merged[k] = v;
      }
    }
    // Derive NO bid/ask from YES complement whenever the merged result is
    // missing them — covers REST-only snapshots and post-close windows where
    // the WS tick never arrived with NO prices.
    if (merged.no_bid == null && typeof merged.yes_ask === 'number') merged.no_bid = 100 - (merged.yes_ask as number);
    if (merged.no_ask == null && typeof merged.yes_bid === 'number') merged.no_ask = 100 - (merged.yes_bid as number);
    return merged as unknown as Market;
  };

  const btcMarket = useMemo(() => {
    if (!btcPollMarket) return undefined;
    return mergeLive(btcPollMarket, streamData[btcPollMarket.ticker as string]);
  }, [btcPollMarket, streamData]);

  const ethMarket = useMemo(() => {
    if (!ethPollMarket) return undefined;
    return mergeLive(ethPollMarket, streamData[ethPollMarket.ticker as string]);
  }, [ethPollMarket, streamData]);

  const solMarket = useMemo(() => {
    if (!solPollMarket) return undefined;
    return mergeLive(solPollMarket, streamData[solPollMarket.ticker as string]);
  }, [solPollMarket, streamData]);

  // A position belongs beneath a market panel only when its exact market ticker
  // matches. This prevents a just-closed holding from appearing on the next
  // 15-minute window.
  const btcOpenPosition = useMemo(
    () => openPositions?.find((position) => position.ticker === btcMarket?.ticker) ?? null,
    [openPositions, btcMarket?.ticker],
  );
  const ethOpenPosition = useMemo(
    () => openPositions?.find((position) => position.ticker === ethMarket?.ticker) ?? null,
    [openPositions, ethMarket?.ticker],
  );
  const solOpenPosition = useMemo(
    () => openPositions?.find((position) => position.ticker === solMarket?.ticker) ?? null,
    [openPositions, solMarket?.ticker],
  );

  // Keep a ref to the last known market for each asset so we can show stale
  // data dimmed during the inter-window gap instead of blanking to "No active market".
  const lastKnownBtcMarket = useRef<Market | undefined>(undefined);
  const lastKnownEthMarket = useRef<Market | undefined>(undefined);
  const lastKnownSolMarket = useRef<Market | undefined>(undefined);
  if (btcMarket) lastKnownBtcMarket.current = btcMarket;
  if (ethMarket) lastKnownEthMarket.current = ethMarket;
  if (solMarket) lastKnownSolMarket.current = solMarket;

  // Countdowns computed at this level so time-alerts can fire here
  const btcCountdown = useCountdown(btcMarket?.close_time);
  const ethCountdown = useCountdown(ethMarket?.close_time);
  const solCountdown = useCountdown(solMarket?.close_time);

  // Update timestamp from poll OR from stream
  useEffect(() => {
    if (btcUpdated || ethUpdated || solUpdated) {
      setLastUpdated(new Date(Math.max(btcUpdated ?? 0, ethUpdated ?? 0, solUpdated ?? 0)));
    }
  }, [btcUpdated, ethUpdated, solUpdated]);

  useEffect(() => {
    const hasBtc = btcMarket?.ticker && streamData[btcMarket.ticker as string];
    const hasEth = ethMarket?.ticker && streamData[ethMarket.ticker as string];
    const hasSol = solMarket?.ticker && streamData[solMarket.ticker as string];
    if (hasBtc || hasEth || hasSol) setLastUpdated(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamData]);

  // Fire alert helper
  const fireAlert = useCallback((key: string, asset: 'BTC' | 'ETH' | 'SOL', side: 'YES' | 'NO', price: number, ticker: string, eventTicker: string) => {
    if (firedRef.current.has(key)) return;
    firedRef.current.add(key);
    playBeep();
    sendNotification(
      `${asset} ${side} browser quote alert`,
      `${asset} 15-min direct ${side} BBO bid ${price}¢ on ${ticker} — browser-only observation; server evaluates independently`,
    );
    setAlertLog((prev) => [
      { id: `${key}-${Date.now()}`, asset, side, price, ticker, eventTicker, time: new Date() },
      ...prev.slice(0, 19),
    ]);
  }, []);

  // Alert-only effect — runs on every market refresh AND every countdown tick.
  // Orders are placed server-side; this only surfaces direct BBO quote alerts.
  useEffect(() => {
    if (!alertsEnabled) return;
    const check = (market: Market | undefined, countdown: CountdownState, asset: 'BTC' | 'ETH' | 'SOL') => {
      if (!market) return;
      const { ticker, event_ticker, yes_bid, no_bid } = market;
      const et = (event_ticker as string) ?? ticker;
      if (countdown.secondsLeft === null || countdown.secondsLeft <= 0 || countdown.secondsLeft > timeAlertSeconds) return;

      if (yes_bid != null && yes_bid >= alertMin && yes_bid <= alertMax) {
        fireAlert(`${ticker}-YES`, asset, 'YES', yes_bid, ticker, et);
      }
      if (no_bid != null && no_bid >= alertMin && no_bid <= alertMax) {
        fireAlert(`${ticker}-NO`, asset, 'NO', no_bid, ticker, et);
      }
    };
    check(btcMarket, btcCountdown, 'BTC');
    check(ethMarket, ethCountdown, 'ETH');
    check(solMarket, solCountdown, 'SOL');
  }, [btcMarket, ethMarket, solMarket, btcCountdown.secondsLeft, ethCountdown.secondsLeft, solCountdown.secondsLeft, alertsEnabled, fireAlert, alertMin, alertMax, timeAlertSeconds]);

  // Reset fired keys when the 15-min window rolls over (ticker changes).
  // Keys are `${ticker}-YES` or `${ticker}-NO`, e.g. "KXBTC15M-290315-15-NO".
  // startsWith(ticker) matches both suffixes: when the ticker advances to the
  // next window (e.g. "KXBTC15M-290315-30") the old key no longer starts with
  // the new ticker string, so isStale returns true and the key is evicted.
  // This allows both YES and NO alerts to re-arm for window N+1.
  useEffect(() => {
    const currentTickers = new Set([btcMarket?.ticker, ethMarket?.ticker, solMarket?.ticker].filter(Boolean));
    const isStale = (k: string) => ![...currentTickers].some((t) => k.startsWith(t!));
    [...firedRef.current].filter(isStale).forEach((k) => firedRef.current.delete(k));
  }, [btcMarket?.ticker, ethMarket?.ticker, solMarket?.ticker]);

  const hasFired = (ticker: string | undefined, suffix: string) =>
    !!ticker && firedRef.current.has(`${ticker}-${suffix}`);

  const btcTriggered = {
    yes: hasFired(btcMarket?.ticker, 'YES'),
    no:  hasFired(btcMarket?.ticker, 'NO'),
  };
  const ethTriggered = {
    yes: hasFired(ethMarket?.ticker, 'YES'),
    no:  hasFired(ethMarket?.ticker, 'NO'),
  };
  const solTriggered = {
    yes: hasFired(solMarket?.ticker, 'YES'),
    no:  hasFired(solMarket?.ticker, 'NO'),
  };

  const toggleAlerts = async () => {
    if (!alertsEnabled && permission === 'default') await requestPermission();
    setAlertsEnabled((v) => !v);
  };

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">BTC, ETH &amp; SOL 15-Minute Markets</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Direct BBO bid alerts when YES or NO enters {alertMin}¢ – {alertMax}¢ · last {fmtWindowTime(timeAlertSeconds)} of window
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* AutoTrader health badge */}
            {autoTraderStatus && (() => {
              const staleSecs = autoTraderStatus.lastTickMs > 0
                ? Math.floor((Date.now() - autoTraderStatus.lastTickMs) / 1000)
                : null;
              const isWsLive    = autoTraderStatus.wsLive;
              const isWsStale   = !isWsLive && staleSecs !== null && staleSecs <= 120;
              const label       = isWsLive ? "WS live" : "REST fallback";
              const tickerLabel = autoTraderStatus.currentTicker
                ? autoTraderStatus.currentTicker.split("-").slice(-1)[0] // e.g. "290315-15"
                : null;
              return (
                <span
                  title={
                    autoTraderStatus.currentTicker
                      ? `Trigger: ${autoTraderStatus.source} · ticker: ${autoTraderStatus.currentTicker}${staleSecs !== null ? ` · last tick ${staleSecs}s ago` : ""}`
                      : `Trigger: ${autoTraderStatus.source} · no active ticker yet`
                  }
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border",
                    isWsLive
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                      : isWsStale
                        ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-400"
                        : "bg-orange-500/10 border-orange-500/30 text-orange-600 dark:text-orange-400",
                  )}
                >
                  <span className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    isWsLive ? "bg-emerald-500" : isWsStale ? "bg-yellow-500" : "bg-orange-500",
                  )} />
                  {label}
                  {staleSecs !== null && (
                    <span className="opacity-70 font-normal">
                      &nbsp;{staleSecs}s
                    </span>
                  )}
                  {tickerLabel && (
                    <span className="opacity-50 font-normal ml-0.5 hidden sm:inline">
                      {tickerLabel}
                    </span>
                  )}
                </span>
              );
            })()}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {streamConnected
                ? <span className="flex items-center gap-1 text-chart-3 font-medium">
                    <Zap className="h-3.5 w-3.5 fill-current" />
                    LIVE
                  </span>
                : null}
              {lastUpdated
                ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '—'}
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                title="Refresh market data"
                className="ml-1 p-1 rounded hover:bg-muted transition-colors disabled:opacity-40"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
              </button>
            </div>
            <button
              onClick={toggleAlerts}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                alertsEnabled
                  ? 'bg-chart-3/10 border-chart-3/30 text-chart-3 hover:bg-chart-3/20'
                  : 'bg-muted border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {alertsEnabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
              {alertsEnabled ? 'Alerts on' : 'Alerts off'}
            </button>
          </div>
        </div>

        {/* Notification permission banner */}
        {alertsEnabled && permission === 'default' && (
          <div className="flex items-center justify-between gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-4 py-3">
            <p className="text-sm text-yellow-600 dark:text-yellow-400">
              Allow browser notifications to get direct BBO quote alerts.
            </p>
            <button
              onClick={requestPermission}
              className="text-sm font-medium text-yellow-600 dark:text-yellow-400 underline underline-offset-2 whitespace-nowrap hover:opacity-80"
            >
              Enable
            </button>
          </div>
        )}

        {/* Server-owned watchdog alert banner — active alerts disappear on recovery. */}
        <RuntimeWatchdogAlertBanner status={runtimeWatchdogStatus} />

        {/* Protective-exit monitor incident banner — high-severity, shown whenever incidents exist */}
        <ProtectiveExitMonitorBanner incidents={peIncidents} onAcknowledge={acknowledgeIncident} ackError={peAckError} />
        <MixedEthOwnershipAlert
          tickers={protectiveExitMonitorStatus?.mixedEthStrategyOwnershipTickers ?? []}
          onViewEvidence={viewProtectiveExitEvidence}
        />

        {/* Trading conditions strip */}
        <div className="flex flex-wrap gap-2">
          {/* Auto-trading status */}
          <div className={cn(
            'flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium',
            tradeStatus === null
              ? 'bg-muted border-border text-muted-foreground'
              : tradeStatus.trading_halted
                ? 'bg-destructive/10 border-destructive/30 text-destructive'
                : 'bg-chart-3/10 border-chart-3/30 text-chart-3',
          )}>
            <span className={cn(
              'h-1.5 w-1.5 rounded-full',
              tradeStatus === null ? 'bg-muted-foreground' :
              tradeStatus.trading_halted ? 'bg-destructive' : 'bg-chart-3 animate-pulse',
            )} />
            {tradeStatus === null ? '—' : tradeStatus.trading_halted ? 'Trading HALTED' : 'Auto-trading ACTIVE'}
          </div>

          {/* Bet per trade */}
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-card border-border text-xs">
            <span className="text-muted-foreground">Bet / trade</span>
            {tradeStatus ? (
              <span className="flex items-center gap-2 font-mono font-semibold text-foreground">
                <span>BTC ${tradeStatus.bet_dollars_btc}</span>
                <span className="text-muted-foreground">·</span>
                <span>ETH ${tradeStatus.bet_dollars_eth}</span>
              </span>
            ) : (
              <span className="font-mono font-semibold text-foreground">—</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-card border-border text-xs">
            <span className="text-muted-foreground">Kalshi account settled P&amp;L today</span>
            <span className="font-mono font-semibold text-foreground">
              {accountSettledPnl?.realizedPnl != null
                ? formatSignedUsd(accountSettledPnl.realizedPnl)
                : accountSettledPnl ? 'no settled fills' : 'loading…'}
            </span>
            {accountSettledPnl && (
              <span
                title="Account-wide Kalshi exchange history. This includes fills not proven to belong to this bot."
                className="text-[10px] text-muted-foreground"
              >
                exchange history · {accountSettledPnl.settledFillCount} fills
              </span>
            )}
            {accountSettledPnl && accountFillsStale && (
              <span
                title="Kalshi is temporarily rate-limiting fills history. Showing the last successful values; they will refresh automatically."
                className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
              >
                stale
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-card border-border text-xs">
            <span className="text-muted-foreground">
              {!isBotPnlVerifiedToday(tradeStatus)
                ? 'Settled P&L today (verifying exchange history)'
                : (tradeStatus?.daily_realized_pending_fill_count ?? 0) > 0
                ? 'Settled P&L today (awaiting verification)'
                : (tradeStatus?.daily_realized_unverified_fill_count ?? 0) > 0
                ? 'Settled P&L today (excl. unverified)'
                : 'Verified bot P&L today'}
            </span>
            <span className={cn(
              'font-mono font-semibold',
              !isBotPnlVerifiedToday(tradeStatus) ||
              (tradeStatus?.daily_realized_pending_fill_count ?? 0) > 0 ||
              (tradeStatus?.daily_realized_unverified_fill_count ?? 0) > 0
                ? 'text-yellow-500'
                : 'text-foreground',
            )}>
              {tradeStatus?.daily_realized_net_pnl_dollars != null
                ? formatSignedUsd(tradeStatus.daily_realized_net_pnl_dollars)
                : "unavailable"}
            </span>
            {(tradeStatus?.daily_realized_pending_fill_count ?? 0) > 0 && (
              <span
                title={`${tradeStatus!.daily_realized_pending_fill_count} settled order(s) still need verified Kalshi fill chunks`}
                className="flex items-center gap-0.5 text-yellow-500"
              >
                <AlertTriangle className="h-3 w-3" />
                <span className="text-[10px] font-medium">pending</span>
              </span>
            )}
            {(tradeStatus?.daily_realized_pending_fill_count ?? 0) === 0 &&
              (tradeStatus?.daily_realized_unverified_fill_count ?? 0) > 0 && (
              <span
                title={`${tradeStatus!.daily_realized_unverified_fill_count} fill(s) excluded — fee reconciliation failed, pre-fee profit not counted as net P&L`}
                className="flex items-center gap-0.5 text-yellow-500"
              >
                <AlertTriangle className="h-3 w-3" />
                <span className="text-[10px] font-medium">pre-fee</span>
              </span>
            )}
          </div>
          <div className={cn(
            'flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs',
            tradeStatus?.kalshi_daily_realized_pnl?.state === 'target_reached'
              ? 'bg-destructive/10 border-destructive/30 text-destructive'
              : tradeStatus?.kalshi_daily_realized_pnl?.state === 'unavailable'
                ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-700'
                : 'bg-card border-border',
          )}>
            <span
              className="text-muted-foreground"
              title={tradeStatus?.kalshi_daily_realized_pnl?.retrievedAt
                ? `Kalshi account-history source verified ${new Date(tradeStatus.kalshi_daily_realized_pnl.retrievedAt).toLocaleString()}`
                : 'Kalshi account-history source is unavailable'}
            >Kalshi daily realized P&amp;L</span>
            <span className="font-mono font-semibold">
              {tradeStatus?.kalshi_daily_realized_pnl?.realizedPnlDollars != null
                ? formatSignedUsd(tradeStatus.kalshi_daily_realized_pnl.realizedPnlDollars)
                : 'unavailable'} / ${tradeStatus?.daily_profit_target_dollars ?? 75}.00
            </span>
            {tradeStatus?.kalshi_daily_realized_pnl?.state === 'target_reached' && (
              <span className="font-medium">$75 DAILY PROFIT TARGET REACHED — NEW INVESTMENTS STOPPED UNTIL MIDNIGHT ET</span>
            )}
            {tradeStatus?.kalshi_daily_realized_pnl?.state === 'unavailable' && (
              <span className="font-medium">FAIL-CLOSED: exchange history unavailable</span>
            )}
          </div>

          {/* Protective-exit monitor incident count chip — always visible when incidents exist */}
          {peIncidents.length > 0 && (
            <div
              title={`${peIncidents.length} high-severity protective-exit monitor incident${peIncidents.length !== 1 ? 's' : ''} — see banner above for details`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-destructive/10 border-destructive/40 text-destructive text-xs font-semibold"
            >
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>
                {peIncidents.length} exit-monitor incident{peIncidents.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          {/* Orphaned fill links */}
          {(tradeStatus?.orphanedFillLinks?.count ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-destructive/10 border-destructive/30 text-destructive text-xs font-medium">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>
                {tradeStatus!.orphanedFillLinks!.count} broken fill link{tradeStatus!.orphanedFillLinks!.count !== 1 ? 's' : ''}
              </span>
            </div>
          )}

          {/* Entry zone */}
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-card border-border text-xs">
            <span className="text-muted-foreground">Entry zone</span>
            <span className="font-mono font-semibold text-foreground">
              {tradeStatus ? `${tradeStatus.alert_min}¢ – ${tradeStatus.alert_max}¢` : '—'}
            </span>
          </div>

          {/* Timing */}
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-card border-border text-xs">
            <span className="text-muted-foreground">Timing</span>
            <span className="font-mono font-semibold text-foreground">
              {tradeStatus
                ? `last ${Math.floor(tradeStatus.time_alert_seconds / 60)}:${String(tradeStatus.time_alert_seconds % 60).padStart(2, '0')} of window`
                : '—'}
            </span>
          </div>

          {/* Daily budget remaining */}
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg border bg-card border-border text-xs">
            <span className="text-muted-foreground">Budget left today</span>
            <span className="font-mono font-semibold text-foreground">
              {tradeStatus
                ? `$${(tradeStatus.remaining_cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} of $${(tradeStatus.max_daily_notional_cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                : '—'}
            </span>
          </div>
        </div>

        {/* Daily analytics summary strip */}
        {dailySummary && (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            {[
              { label: 'Submissions', value: dailySummary.combined.orderSubmissions.toString() },
              { label: 'Fills', value: dailySummary.combined.successfulFills.toString() },
              { label: 'Zero-fills', value: dailySummary.combined.zeroFills.toString() },
              {
                label: 'Fill rate',
                value: dailySummary.combined.fillRateByOrderAttempt != null
                  ? `${(dailySummary.combined.fillRateByOrderAttempt * 100).toFixed(0)}%`
                  : '—',
              },
              { label: 'BTC fills', value: dailySummary.btc.successfulFills.toString() },
              { label: 'ETH fills', value: dailySummary.eth.successfulFills.toString() },
              { label: 'Filled $', value: `$${dailySummary.combined.filledNotionalDollars.toFixed(2)}` },
            ].map(({ label, value }) => (
              <div key={label} className="bg-card border border-border rounded-lg px-3 py-2 text-center">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
                <div className="font-mono font-semibold text-sm text-foreground mt-0.5">{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Protective exits are intentionally separate from strategy entries. */}
        {(() => {
          // Outcomes that represent a bypassed or failed exit — position may still be at risk.
          const BYPASS_OUTCOMES = new Set([
            'not_armed', 'gap_below_floor', 'book_unavailable', 'zero_fill', 'mixed_eth_strategy_ownership',
          ]);
          const displayedProtectiveExits = filterProtectiveExitEvidence(
            protectiveExits,
            protectiveExitEvidenceTicker,
          );
          const bypassRows = displayedProtectiveExits.filter((e) => BYPASS_OUTCOMES.has(e.outcome));
          // not_armed is the most critical: exit system was suppressed for a live position.
          const notArmedRows = displayedProtectiveExits.filter((e) => e.outcome === 'not_armed');
          const hasBypass = bypassRows.length > 0;
          const hasNotArmed = notArmedRows.length > 0;

          const outcomeStyle = (outcome: string): string => {
            if (outcome === 'not_armed') return 'text-destructive font-semibold';
            if (outcome === 'mixed_eth_strategy_ownership') return 'text-destructive font-semibold';
            if (outcome === 'gap_below_floor') return 'text-destructive font-semibold';
            if (outcome === 'book_unavailable') return 'text-orange-500 font-semibold';
            if (outcome === 'zero_fill') return 'text-yellow-500 font-semibold';
            if (outcome === 'full_fill') return 'text-chart-3 font-semibold';
            if (outcome === 'partial_fill') return 'text-chart-2 font-semibold';
            return 'text-muted-foreground';
          };

          return (
            <section id={PROTECTIVE_EXIT_EVIDENCE_SECTION_ID} className={cn(
              'border rounded-xl p-4',
              hasNotArmed
                ? 'border-destructive/40 bg-destructive/5'
                : hasBypass
                  ? 'border-orange-500/30 bg-orange-500/5'
                  : 'border-amber-500/30 bg-amber-500/5',
            )}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    Protective exits
                    {hasNotArmed && (
                      <span className="flex items-center gap-1 text-xs font-semibold text-destructive bg-destructive/10 border border-destructive/30 px-2 py-0.5 rounded-full">
                        <AlertTriangle className="h-3 w-3" />
                        EXIT BYPASSED
                      </span>
                    )}
                    {!hasNotArmed && hasBypass && (
                      <span className="flex items-center gap-1 text-xs font-semibold text-orange-600 dark:text-orange-400 bg-orange-500/10 border border-orange-500/30 px-2 py-0.5 rounded-full">
                        <AlertTriangle className="h-3 w-3" />
                        {bypassRows.length} bypass{bypassRows.length !== 1 ? 'es' : ''}
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    80¢ IOC exit audit trail — separate from entry strategy activity.
                  </p>
                  {protectiveExitEvidenceTicker && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-muted-foreground">
                        Showing durable evidence for <span className="font-mono font-semibold text-foreground">{protectiveExitEvidenceTicker}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setProtectiveExitEvidenceTicker(null)}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        Show all
                      </button>
                    </div>
                  )}
                </div>
                <span className={cn(
                  'text-xs font-mono px-2 py-1 rounded',
                  hasNotArmed
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                )}>
                  {displayedProtectiveExits.length}{protectiveExitEvidenceTicker ? ' matching' : ' recorded'}
                </span>
              </div>

              {/* Warning banner for not_armed rows */}
              {hasNotArmed && (
                <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2.5 mb-3 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Protective exit suppressed</span>
                    {' '}— {notArmedRows.length} position{notArmedRows.length !== 1 ? 's' : ''} reached the 80¢ floor while
                    the exit system was disabled (<code className="font-mono text-[10px]">PROTECTIVE_EXIT_ENABLED≠true</code>).
                    Check <code className="font-mono text-[10px]">not_armed</code> rows below; the position
                    may still be open.
                  </div>
                </div>
              )}

              {displayedProtectiveExits.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">
                  {protectiveExitEvidenceTicker
                    ? `No protective-exit evidence is currently loaded for ${protectiveExitEvidenceTicker}.`
                    : 'No protective exit attempts recorded.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground border-b border-border">
                      <tr className="text-left">
                        <th className="pb-2 pr-3 font-medium">Market / held</th>
                        <th className="pb-2 pr-3 font-medium">Entry → trigger / limit</th>
                        <th className="pb-2 pr-3 font-medium">Bid / fill</th>
                        <th className="pb-2 pr-3 font-medium">Sold / remaining</th>
                        <th className="pb-2 font-medium">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedProtectiveExits.map((exit) => {
                        const isBypass = BYPASS_OUTCOMES.has(exit.outcome);
                        const realizedPnl = exit.fillQuantity && exit.averageExitPriceCents != null && exit.originalEntryPriceCents != null
                          ? ((exit.averageExitPriceCents - exit.originalEntryPriceCents) * exit.fillQuantity / 100) : null;
                        return (
                          <tr key={exit.id} className={cn(
                            'border-b border-border/60 last:border-0 align-top',
                            isBypass && 'bg-destructive/5',
                          )}>
                            <td className="py-2 pr-3 font-mono">
                              <div className="flex items-center gap-1.5">
                                {exit.asset}
                                <span className={exit.heldSide === 'yes' ? 'text-primary' : 'text-destructive'}>
                                  {exit.heldSide.toUpperCase()}
                                </span>
                                {isBypass && (
                                  <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
                                )}
                              </div>
                              <div className="text-muted-foreground max-w-[180px] truncate">{exit.ticker}</div>
                              <div className="text-muted-foreground/70 tabular-nums">
                                {new Date(exit.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </div>
                            </td>
                            <td className="py-2 pr-3 font-mono">
                              {exit.originalEntryPriceCents ?? '—'}¢ → {exit.triggerCents}¢ / {exit.limitPriceCents}¢
                            </td>
                            <td className="py-2 pr-3 font-mono">
                              {exit.executableBidCents ?? '—'}¢ / {exit.averageExitPriceCents ?? '—'}¢
                              {realizedPnl != null && (
                                <div className={realizedPnl >= 0 ? 'text-chart-3' : 'text-destructive'}>
                                  {formatSignedUsd(realizedPnl)}
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-3 font-mono">
                              {exit.fillQuantity ?? 0} / {exit.remainingPosition ?? exit.confirmedPositionBefore}
                            </td>
                            <td className="py-2">
                              <div className={outcomeStyle(exit.outcome)}>
                                {exit.outcome.replaceAll('_', ' ')}
                              </div>
                              {exit.reason && (
                                <div className="text-muted-foreground text-[10px] mt-0.5">
                                  {exit.reason.replaceAll('_', ' ')}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })()}

        {/* P&L stats bar */}
        {dailySummary && (() => {
          const c = dailySummary.combined;
          const v = dailySummary.verified;

          const resolvedCount = c.winsCount + c.lossesCount;
          const winRatePct = c.winRate != null ? c.winRate * 100 : null;
          // EV in cents per $1 wagered: (win_rate - entry_price_fraction) × 100
          const entryFraction = c.avgActualFillPriceCents != null ? c.avgActualFillPriceCents / 100 : null;
          const evCents = c.winRate != null && entryFraction != null
            ? (c.winRate - entryFraction) * 100
            : null;
          const isNegativeEv = evCents !== null && evCents < 0;
          const hasResolved = resolvedCount > 0;

          // The primary number is account-wide Kalshi exchange history when it
          // has loaded. Bot-only ledger P&L remains visible as a separate,
          // provenance-safe figure rather than being mislabeled as total P&L.
          const verifiedPnl       = v?.netPnlDollars ?? null;
          const verifiedPending   = (v?.pendingVerificationCount ?? 0) > 0;
          const verifiedAvailable = v !== undefined;
          const accountPnl        = accountSettledPnl?.realizedPnl ?? null;
          const displayPnl        = accountPnl ?? verifiedPnl ?? (hasResolved ? c.netPnlDollars : null);
          const isAccountTotal    = accountPnl !== null;
          const isEstimate        = accountPnl === null && verifiedPnl === null && hasResolved;
          const isVerifiedPending = verifiedAvailable && verifiedPending;

          return (
            <div className={cn(
              'flex flex-wrap gap-3 p-4 rounded-xl border',
              isNegativeEv
                ? 'bg-destructive/5 border-destructive/30'
                : hasResolved
                  ? 'bg-chart-3/5 border-chart-3/20'
                  : 'bg-card border-border',
            )}>
              {/* Label */}
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide self-center mr-2">
                <TrendingUp className="h-3.5 w-3.5" />
                Today's P&amp;L
              </div>

              {/* Trades resolved */}
              <div className="flex flex-col items-center min-w-[64px]">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Resolved</div>
                <div className="font-mono font-semibold text-sm text-foreground mt-0.5">
                  {hasResolved ? resolvedCount : '—'}
                </div>
              </div>

              {/* Win rate */}
              <div className="flex flex-col items-center min-w-[64px]">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Win rate</div>
                <div className={cn(
                  'font-mono font-semibold text-sm mt-0.5',
                  !hasResolved ? 'text-muted-foreground' :
                  isNegativeEv ? 'text-destructive' : 'text-chart-3',
                )}>
                  {winRatePct != null ? `${winRatePct.toFixed(0)}%` : '—'}
                </div>
              </div>

              {/* W / L */}
              {hasResolved && (
                <div className="flex flex-col items-center min-w-[64px]">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">W / L</div>
                  <div className="font-mono font-semibold text-sm text-foreground mt-0.5">
                    <span className="text-chart-3">{c.winsCount}</span>
                    <span className="text-muted-foreground mx-0.5">/</span>
                    <span className="text-destructive">{c.lossesCount}</span>
                  </div>
                </div>
              )}

              {/* Primary P&L — Kalshi account history preferred over bot-only ledger */}
              <div className="flex flex-col items-center min-w-[80px]">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wide">
                  {isAccountTotal ? 'Kalshi P&L' : 'Bot P&L'}
                  {isAccountTotal && (
                    <span
                      className="text-muted-foreground normal-case"
                      title="Account-wide settled Kalshi exchange history for today. The surrounding win/loss and EV metrics remain verified bot-performance metrics."
                    >
                      (all fills)
                    </span>
                  )}
                  {isEstimate && !isVerifiedPending && (
                    <span
                      className="text-yellow-500"
                      title="Analytics estimate — verified fill ledger unavailable (DB unreachable or no settled fills yet)"
                    >
                      (est.)
                    </span>
                  )}
                  {isVerifiedPending && (
                    <span
                      className="text-yellow-500"
                      title={`${v!.pendingVerificationCount} settled order(s) still awaiting verified Kalshi fill chunks`}
                    >
                      (pending)
                    </span>
                  )}
                </div>
                <div className={cn(
                  'flex items-center gap-1 font-mono font-semibold text-sm mt-0.5',
                  displayPnl === null ? 'text-muted-foreground' :
                  displayPnl > 0 ? 'text-chart-3' :
                  displayPnl < 0 ? 'text-destructive' : 'text-muted-foreground',
                )}>
                  {displayPnl !== null ? formatSignedUsd(displayPnl) : '—'}
                  {isVerifiedPending && (
                    <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />
                  )}
                </div>
                {isAccountTotal && verifiedPnl !== null && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    verified bot {formatSignedUsd(verifiedPnl)}
                  </div>
                )}
              </div>

              {/* EV estimate */}
              {evCents !== null && (
                <div className="flex flex-col items-center min-w-[80px]">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">EV est.</div>
                  <div className={cn(
                    'font-mono font-semibold text-sm mt-0.5',
                    evCents >= 0 ? 'text-chart-3' : 'text-destructive',
                  )}>
                    {evCents >= 0 ? '+' : ''}{evCents.toFixed(1)}¢ / $1
                  </div>
                </div>
              )}

              {/* Avg entry */}
              {c.avgActualFillPriceCents != null && (
                <div className="flex flex-col items-center min-w-[64px]">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Avg entry</div>
                  <div className="font-mono font-semibold text-sm text-foreground mt-0.5">
                    {c.avgActualFillPriceCents.toFixed(1)}¢
                  </div>
                </div>
              )}

              {/* Context note when no resolved trades yet */}
              {!hasResolved && (
                <div className="text-xs text-muted-foreground italic self-center ml-1">
                  Win/loss P&amp;L populates after market resolution
                </div>
              )}
            </div>
          );
        })()}

        {/* Per-series win rate breakdown */}
        {(dailySummary || pnlReport) && (() => {
          const seriesRows = (['btc', 'eth'] as const).map((key) => {
            const label   = key.toUpperCase() as 'BTC' | 'ETH';
            const daily   = dailySummary?.[key];
            const pnlRow  = pnlReport?.byAsset.find((r) => r.asset === label);

            const windowsEntered = daily?.windowsEnteringZone ?? 0;
            const fills          = pnlRow?.fills   ?? daily?.successfulFills ?? 0;
            const wins           = pnlRow?.wins     ?? 0;
            const losses         = pnlRow?.losses   ?? 0;
            const winRate        = pnlRow?.winRate  ?? null;
            const spend          = daily?.filledNotionalDollars ?? 0;
            const netPnl         = pnlRow?.netPnlDollars ?? null;

            return { label, windowsEntered, fills, wins, losses, winRate, spend, netPnl };
          });

          const anyData = seriesRows.some((r) => r.fills > 0 || r.windowsEntered > 0);
          if (!anyData) return null;

          return (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-b border-border">
                <div>
                  <div className="text-sm font-semibold text-foreground">Series Breakdown</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Win rate and P&amp;L per asset · today</div>
                </div>
                {tradeStatus?.trading_halted === false && (
                  <span className="text-[10px] text-muted-foreground bg-muted px-2 py-1 rounded">
                    Use <span className="font-medium text-foreground">Trading HALTED</span> toggle above to pause all series
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/20">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Series</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Windows entered</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Fills</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Wins</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Losses</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Win rate</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Spend</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">Net P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {seriesRows.map(({ label, windowsEntered, fills, wins, losses, winRate, spend, netPnl }) => {
                      const isGoodRate  = winRate !== null && winRate >= 0.5;
                      const isBadRate   = winRate !== null && winRate < 0.5 && fills > 0;
                      const pnlPositive = netPnl !== null && netPnl > 0;
                      const pnlNegative = netPnl !== null && netPnl < 0;
                      return (
                        <tr key={label} className="hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-3">
                            <span className={cn(
                              'font-bold text-xs px-2 py-0.5 rounded',
                              label === 'BTC' ? 'bg-chart-1/15 text-chart-1' : label === 'ETH' ? 'bg-chart-2/15 text-chart-2' : 'bg-chart-4/15 text-chart-4',
                            )}>
                              {label}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-center tabular-nums text-foreground">
                            {windowsEntered || '—'}
                          </td>
                          <td className="px-3 py-3 text-center tabular-nums text-foreground">
                            {fills || '—'}
                          </td>
                          <td className="px-3 py-3 text-center tabular-nums text-chart-3 font-medium">
                            {fills > 0 ? wins : '—'}
                          </td>
                          <td className="px-3 py-3 text-center tabular-nums text-destructive font-medium">
                            {fills > 0 ? losses : '—'}
                          </td>
                          <td className="px-3 py-3 text-center">
                            {winRate === null || fills === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className={cn(
                                'inline-flex items-center gap-1 font-semibold tabular-nums',
                                isGoodRate ? 'text-chart-3' : isBadRate ? 'text-destructive' : 'text-foreground',
                              )}>
                                {isGoodRate ? <TrendingUp className="h-3 w-3" /> : isBadRate ? <TrendingDown className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                                {(winRate * 100).toFixed(0)}%
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums font-mono text-foreground">
                            {spend > 0 ? `$${spend.toFixed(2)}` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums font-mono font-semibold">
                            {netPnl === null || fills === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className={cn(
                                pnlPositive ? 'text-chart-3' : pnlNegative ? 'text-destructive' : 'text-muted-foreground',
                              )}>
                                {pnlPositive ? '+' : ''}{netPnl.toFixed(2)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* Final-window market-data coverage — prominent when a gap exists */}
        <MarketDataCoveragePanel />
        <CompactShadowCollectionPanel />
        <PassiveProgramReadinessPanel />

        {/* Panels */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          <MarketPanel
            asset="BTC"
            market={btcMarket}
            lastKnownMarket={lastKnownBtcMarket.current}
            isLoading={btcLoading}
            alertsEnabled={alertsEnabled}
            triggered={btcTriggered}
            countdown={btcCountdown}
            livePrice={prices?.btc ?? null}
            alertMin={alertMin}
            alertMax={alertMax}
            timeAlertSeconds={timeAlertSeconds}
            openPosition={btcOpenPosition}
            positionsLoaded={openPositions !== null}
            positionsStale={positionsStale}
          />
          <MarketPanel
            asset="ETH"
            market={ethMarket}
            lastKnownMarket={lastKnownEthMarket.current}
            isLoading={ethLoading}
            alertsEnabled={alertsEnabled}
            triggered={ethTriggered}
            countdown={ethCountdown}
            livePrice={prices?.eth ?? null}
            alertMin={alertMin}
            alertMax={alertMax}
            timeAlertSeconds={timeAlertSeconds}
            openPosition={ethOpenPosition}
            positionsLoaded={openPositions !== null}
            positionsStale={positionsStale}
          />
          <MarketPanel
            asset="SOL"
            market={solMarket}
            lastKnownMarket={lastKnownSolMarket.current}
            isLoading={solLoading}
            alertsEnabled={alertsEnabled}
            triggered={solTriggered}
            countdown={solCountdown}
            livePrice={prices?.sol ?? null}
            alertMin={alertMin}
            alertMax={alertMax}
            timeAlertSeconds={timeAlertSeconds}
            openPosition={solOpenPosition}
            positionsLoaded={openPositions !== null}
            positionsStale={positionsStale}
          />
        </div>

        {/* Alert log — browser-only BBO observations; NOT server trade submissions */}
        {alertLog.length > 0 && (() => {
          // Build a ticker → AnalyticsWindow lookup so each alert row can show the
          // matching server evaluation without an extra fetch.
          const windowByTicker = new Map(analyticsWindows.map((w) => [w.ticker, w]));
          return (
            <div className="border border-yellow-500/20 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-yellow-500/5 border-b border-yellow-500/20">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-yellow-600 dark:text-yellow-400">
                    <Bell className="h-4 w-4" />
                    Browser Quote Alerts
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Browser-observed direct BBO bids in zone · <span className="font-medium">not server trade submissions</span> · server evaluates independently using derived ask
                  </div>
                </div>
                <button
                  onClick={() => setAlertLog([])}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Clear
                </button>
              </div>
              <div className="divide-y divide-border">
                {alertLog.map((entry) => {
                  const win = windowByTicker.get(entry.ticker);
                  // Determine which derived ask the server would have used for this side
                  const serverDerivedAsk = entry.side === 'YES'
                    ? (win?.yesDerivedAsk ?? null)
                    : (win?.noDerivedAsk ?? null);
                  const serverEntered = win != null && win.entered;
                  const serverInZone = win != null && win.inZone;
                  // Find the best server evaluation event for this alert.
                  // Passing the alert side ensures a YES alert is never masked by a
                  // NO event, and terminal outcomes (place_order_rejected) are
                  // preferred over the intermediate `forwarded` handoff.
                  const nearestEvent = findNearestEvalEvent(
                    evaluationEvents, entry.ticker, entry.time.getTime(), 60_000,
                    entry.side.toLowerCase() as 'yes' | 'no',
                  );
                  return (
                    <div key={entry.id} className="px-4 py-2.5 text-sm">
                      {/* Main row: badges + BBO price + time + link */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {/* QUOTE ALERT badge — distinguishes from server preflight/submitted states */}
                          <span className="font-semibold text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border shrink-0 uppercase tracking-wide">
                            Quote alert
                          </span>
                          <span className={cn(
                            'font-bold text-xs px-1.5 py-0.5 rounded shrink-0',
                            entry.asset === 'BTC' ? 'bg-chart-1/15 text-chart-1' : entry.asset === 'ETH' ? 'bg-chart-2/15 text-chart-2' : 'bg-chart-4/15 text-chart-4',
                          )}>
                            {entry.asset}
                          </span>
                          <span className={cn(
                            'font-bold text-xs px-1.5 py-0.5 rounded shrink-0',
                            entry.side === 'YES' ? 'bg-primary/15 text-primary' : 'bg-destructive/15 text-destructive',
                          )}>
                            {entry.side}
                          </span>
                          {/* Price is the direct BBO bid — server uses noDerivedAsk (100 − yesBid) or yesDerivedAsk (100 − noBid) */}
                          <span className="text-foreground font-medium truncate">
                            direct BBO bid <span className="font-mono text-yellow-500">{entry.price}¢</span>
                          </span>
                          <span className="text-xs text-muted-foreground font-mono hidden sm:inline">{entry.ticker}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                          {/* "View market" — not a trade action; link opens the market for manual inspection */}
                          <a
                            href={kalshiUrl(entry.asset, entry.eventTicker)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open this market on Kalshi for manual inspection — the server may or may not have placed an order"
                            className="text-xs font-medium text-muted-foreground bg-muted border border-border px-2.5 py-1 rounded-full hover:text-foreground hover:bg-muted/80 transition-colors whitespace-nowrap"
                          >
                            View market →
                          </a>
                        </div>
                      </div>
                      {/* Server evaluation sub-row */}
                      <div className="mt-1.5 ml-0.5 flex items-center gap-2 flex-wrap">
                        {win == null ? (
                          // No analytics window record at all for this ticker
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground border border-border/60"
                            title="The server has no window-log entry for this ticker — it may not have received a WebSocket tick for this window yet, or the window log is still loading."
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                            Server: no evaluation record
                          </span>
                        ) : !serverEntered ? (
                          // Window log exists but server never called evaluate() for it
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground border border-border/60"
                            title="The server opened this window but never reached the evaluation tick — no quote was received before window close."
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                            Server: window opened, no evaluation tick
                          </span>
                        ) : !serverInZone ? (
                          // Server evaluated but its derived ask was out of zone
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground border border-border/60"
                            title="The server evaluated this window but its derived ask was outside the entry zone — no order was attempted."
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                            Server: evaluated — derived ask out of zone
                          </span>
                        ) : (
                          // Server evaluated and was in zone
                          <>
                            <span
                              className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-chart-3/10 text-chart-3 border border-chart-3/30"
                              title="The server evaluated this window and its derived ask was inside the entry zone."
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-chart-3 shrink-0" />
                              Server: evaluated in zone
                            </span>
                            {serverDerivedAsk != null && (
                              <span
                                className="text-[10px] text-muted-foreground"
                                title={`Server's derived ${entry.side} ask (computed from the opposite BBO bid) vs. the browser's direct BBO bid of ${entry.price}¢`}
                              >
                                server derived ask <span className="font-mono text-foreground">{serverDerivedAsk}¢</span>
                                {' '}vs browser bid <span className="font-mono text-yellow-500">{entry.price}¢</span>
                                {' '}<span className={cn(
                                  'font-mono',
                                  serverDerivedAsk > entry.price ? 'text-destructive' : 'text-chart-3',
                                )}>
                                  ({serverDerivedAsk > entry.price ? '+' : ''}{serverDerivedAsk - entry.price}¢)
                                </span>
                              </span>
                            )}
                          </>
                        )}
                        {/* Outcome summary when available */}
                        {win != null && win.analyticsResult != null && (
                          <span className="text-[10px] text-muted-foreground">
                            · outcome: <span className="font-medium text-foreground">{win.analyticsResult.replace(/_/g, ' ')}</span>
                          </span>
                        )}
                      </div>
                      {/* Per-tick server decision — correlates to the exact alert timestamp */}
                      <div className="mt-1 ml-0.5 flex items-center gap-2 flex-wrap">
                        {nearestEvent == null ? (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 border-l-2 border-muted pl-2"
                            title="No server evaluation event found within 60 s of this alert. The server may have been silent (no WS tick) or the event file is not yet loaded."
                          >
                            <span className="font-medium">Tick-level decision:</span>
                            {' '}server silent — no evaluation event near this time
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-2 text-[10px] border-l-2 border-muted pl-2"
                            title={`Server decision recorded ${Math.round(Math.abs(nearestEvent.timestampMs - entry.time.getTime()) / 1000)}s from alert · source: ${nearestEvent.source}${nearestEvent.preflightDecision ? ` · preflight: ${nearestEvent.preflightDecision}` : ''}`}
                          >
                            <span className="text-muted-foreground font-medium">Tick-level decision</span>
                            <span className={cn('font-semibold', evalOutcomeColor(nearestEvent.outcome))}>
                              {EVAL_OUTCOME_LABEL[nearestEvent.outcome]}
                            </span>
                            {nearestEvent.preflightDecision && (
                              <span className="text-muted-foreground">
                                ({nearestEvent.preflightDecision.replace(/^skip_/, '').replace(/_/g, ' ')})
                              </span>
                            )}
                            <span className="text-muted-foreground/50 tabular-nums">
                              Δ{Math.round(Math.abs(nearestEvent.timestampMs - entry.time.getTime()) / 1000)}s
                            </span>
                            {nearestEvent.yesDerivedAsk != null && (
                              <span className="text-muted-foreground">
                                yes↑<span className="font-mono text-foreground">{nearestEvent.yesDerivedAsk}¢</span>
                              </span>
                            )}
                            {nearestEvent.noDerivedAsk != null && (
                              <span className="text-muted-foreground">
                                no↑<span className="font-mono text-foreground">{nearestEvent.noDerivedAsk}¢</span>
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Analytics window log */}
        {analyticsWindows.length > 0 && (
          <div className="border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-muted/30 border-b border-border">
              <div className="text-sm font-semibold text-foreground">Window Log</div>
              <div className="text-xs text-muted-foreground mt-0.5">Per-window trade analytics · refreshes every 30 s</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/20">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Ticker</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Close</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground">Result</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Settled</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground">Submissions</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground">Zero-fills</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Fill #</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Contracts</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Spend</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground hidden lg:table-cell">Fees</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...analyticsWindows]
                    .sort((a, b) => (b.firstSeenMs ?? 0) - (a.firstSeenMs ?? 0))
                    .slice(0, 30)
                    .map((w) => {
                      const resultColor =
                        w.analyticsResult === 'filled'           ? 'text-chart-3' :
                        w.analyticsResult === 'partial_fill'     ? 'text-chart-2' :
                        w.analyticsResult === 'zero_fill_only'   ? 'text-destructive' :
                        w.analyticsResult === 'no_submission'    ? 'text-muted-foreground' :
                                                                   'text-muted-foreground';
                      const capHit = w.skipReason === 'zero_fill_retry_budget_exhausted';
                      const resultLabel =
                        w.analyticsResult === 'filled'         ? 'filled' :
                        w.analyticsResult === 'partial_fill'   ? 'partial' :
                        w.analyticsResult === 'zero_fill_only' ? (
                          w.outcome === 'zero_fill_retried' ? 'zero-fill · retried' :
                          capHit                            ? 'zero-fill · retry cap hit' :
                                                              'zero-fill') :
                        w.analyticsResult === 'no_submission'  ? 'skipped' :
                        w.outcome === 'zero_fill_retried'      ? 'zero-fill · retried' :
                        w.outcome ?? '—';
                      const closeLabel = w.closeTime
                        ? new Date(w.closeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : '—';
                      // Settlement badge: only meaningful on traded windows
                      const traded = w.analyticsResult === 'filled' || w.analyticsResult === 'partial_fill';
                      const settleBadge = traded
                        ? w.settlementResult === 'yes'
                          ? <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-chart-3/15 text-chart-3">YES</span>
                          : w.settlementResult === 'no'
                          ? <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-destructive/15 text-destructive">NO</span>
                          : <span className="text-muted-foreground/50">…</span>
                        : <span className="text-muted-foreground/30">—</span>;
                      const latestAudit = attemptsByTicker[w.ticker]
                        ?.filter((a) => a.submissionAudit)
                        .sort((a, b) => (b.submissionAudit?.recordedAtMs ?? 0) - (a.submissionAudit?.recordedAtMs ?? 0))[0]
                        ?.submissionAudit;
                      const auditSummary = latestAudit
                        ? `${latestAudit.stage.replaceAll('_', ' ')}${latestAudit.reason ? ` · ${latestAudit.reason.replaceAll('_', ' ')}` : ''}`
                        : null;

                      // ── Evaluation events for this window ──────────────────
                      // Match events by ticker within the window's active period:
                      // from up to 20 min before closeTime (or firstSeenMs) to
                      // 90 s after closeTime (allow for late persistence).
                      const closeMs = w.closeTime ? new Date(w.closeTime).getTime() : null;
                      const windowStartMs = w.firstSeenMs ?? (closeMs != null ? closeMs - 20 * 60_000 : null);
                      const windowEndMs   = closeMs != null ? closeMs + 90_000 : null;
                      const windowEvents: EvaluationEvent[] = evaluationEvents
                        .filter((e) => {
                          if (e.ticker !== w.ticker) return false;
                          if (windowStartMs != null && e.timestampMs < windowStartMs - 60_000) return false;
                          if (windowEndMs   != null && e.timestampMs > windowEndMs)            return false;
                          return true;
                        })
                        .sort((a, b) => a.timestampMs - b.timestampMs);

                      // Amber highlight: server evaluated the window but never
                      // forwarded an order (missed-trade window).
                      const hasEvalEvents = windowEvents.length > 0;
                      const hasForwarded  = windowEvents.some(
                        (e) => e.outcome === 'forwarded' || e.outcome === 'place_order_rejected' ||
                               e.outcome === 'exchange_rejected' || e.outcome === 'post_unknown',
                      );
                      const missedTrade   = hasEvalEvents && !hasForwarded && w.submittedOrders === 0;

                      // Composite key that remains unique even when the same
                      // ticker appears in more than one analytics window row
                      // (e.g. re-opened or back-filled windows for the same market).
                      const windowKey = `${w.ticker}::${w.closeTime ?? String(w.firstSeenMs ?? '')}`;

                      const isExpanded = expandedWindowTickers.has(windowKey);
                      const toggleExpanded = () => setExpandedWindowTickers((prev) => {
                        const next = new Set(prev);
                        if (next.has(windowKey)) next.delete(windowKey); else next.add(windowKey);
                        return next;
                      });

                      return (
                        <Fragment key={windowKey}>
                          <tr
                            className={cn(
                              'transition-colors cursor-pointer select-none',
                              missedTrade
                                ? 'bg-amber-500/8 hover:bg-amber-500/15'
                                : 'hover:bg-muted/20',
                            )}
                            onClick={toggleExpanded}
                            title={hasEvalEvents ? `${windowEvents.length} evaluation event${windowEvents.length !== 1 ? 's' : ''} — click to ${isExpanded ? 'collapse' : 'expand'}` : undefined}
                          >
                            <td className="px-3 py-2 font-mono text-foreground">
                              <span className="flex items-center gap-1.5">
                                {hasEvalEvents
                                  ? isExpanded
                                    ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                                    : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                  : <span className="w-3 shrink-0" />
                                }
                                <span>{w.ticker}</span>
                                {missedTrade && (
                                  <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                                    missed
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground tabular-nums hidden sm:table-cell">{closeLabel}</td>
                            <td
                              className={cn('px-3 py-2 text-center font-medium', resultColor)}
                              title={capHit ? 'retry cap hit' : undefined}
                            >{resultLabel}</td>
                            <td className="px-3 py-2 text-center hidden sm:table-cell">{settleBadge}</td>
                            <td className="px-3 py-2 text-center tabular-nums text-foreground">{w.submittedOrders || '—'}</td>
                            <td className="px-3 py-2 text-center tabular-nums text-foreground">{w.zeroFills || '—'}</td>
                            <td className="px-3 py-2 text-center tabular-nums text-muted-foreground hidden md:table-cell">
                              {w.attemptNumberThatFilled ?? '—'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-foreground hidden md:table-cell">
                              {w.contractsFilled ?? (w.fullFills > 0 ? w.fullFills : null) ?? '—'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-foreground font-mono">
                              {w.totalSpendDollars > 0
                                ? `$${w.totalSpendDollars.toFixed(2)}`
                                : (w.spentDollars != null ? `$${w.spentDollars.toFixed(2)}` : '—')}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground font-mono hidden lg:table-cell">
                              {w.totalFeesDollars > 0 ? `$${w.totalFeesDollars.toFixed(2)}` : '—'}
                            </td>
                          </tr>

                          {/* Evaluation event history — shown when row is expanded */}
                          {isExpanded && (
                            <tr key={`${windowKey}-eval-events`} className={cn('border-b border-border', missedTrade ? 'bg-amber-500/5' : 'bg-muted/10')}>
                              <td colSpan={10} className="px-4 pb-3 pt-1">
                                <div className="rounded-md border border-border/60 bg-background/70 overflow-hidden">
                                  <div className="px-3 py-1.5 border-b border-border/50 flex items-center gap-2 bg-muted/20">
                                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                                      Evaluation history
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {windowEvents.length} event{windowEvents.length !== 1 ? 's' : ''}
                                      {closeMs != null ? ` · close ${new Date(closeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
                                    </span>
                                  </div>
                                  {windowEvents.length === 0 ? (
                                    <div className="px-3 py-2.5 text-[11px] text-muted-foreground italic">
                                      No evaluation events recorded for this window. The server may not have observed this ticker during the window, or events may have fallen outside the 48-hour retention window.
                                    </div>
                                  ) : (
                                    <div className="divide-y divide-border/40">
                                      {windowEvents.map((e, i) => {
                                        const relSec = closeMs != null
                                          ? Math.round((e.timestampMs - closeMs) / 1000)
                                          : null;
                                        const relLabel = relSec != null
                                          ? relSec <= 0
                                            ? `T${relSec}s`
                                            : `T+${relSec}s`
                                          : new Date(e.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                        const outcomeColor = evalOutcomeColor(e.outcome);
                                        const derivedAsk = e.side === 'yes'
                                          ? e.yesDerivedAsk
                                          : e.side === 'no'
                                          ? e.noDerivedAsk
                                          : (e.yesDerivedAsk ?? e.noDerivedAsk);
                                        return (
                                          <div
                                            key={i}
                                            className="px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]"
                                          >
                                            {/* Relative time */}
                                            <span className="font-mono text-muted-foreground tabular-nums w-14 shrink-0">
                                              {relLabel}
                                            </span>
                                            {/* Side badge */}
                                            {e.side && (
                                              <span className={cn(
                                                'px-1 py-0.5 rounded text-[9px] font-bold shrink-0',
                                                e.side === 'yes' ? 'bg-primary/15 text-primary' : 'bg-destructive/15 text-destructive',
                                              )}>
                                                {e.side.toUpperCase()}
                                              </span>
                                            )}
                                            {/* Outcome */}
                                            <span className={cn('font-medium shrink-0', outcomeColor)}>
                                              {EVAL_OUTCOME_LABEL[e.outcome] ?? e.outcome}
                                            </span>
                                            {/* Preflight decision (if any) */}
                                            {e.preflightDecision && (
                                              <span className="text-muted-foreground shrink-0">
                                                · {e.preflightDecision.replaceAll('_', ' ')}
                                              </span>
                                            )}
                                            {/* Derived ask */}
                                            {derivedAsk != null && (
                                              <span className="text-muted-foreground shrink-0">
                                                ask <span className="font-mono">{derivedAsk}¢</span>
                                              </span>
                                            )}
                                            {/* Limit price */}
                                            {e.limitCents != null && (
                                              <span className="text-muted-foreground shrink-0">
                                                limit <span className="font-mono">{e.limitCents}¢</span>
                                              </span>
                                            )}
                                            {/* Fresh L2 evidence is distinct from the earlier derived ask above. */}
                                            {e.freshExecutablePriceCents != null && (
                                              <span className="text-muted-foreground shrink-0">
                                                fresh L2 <span className="font-mono font-medium text-foreground">{e.freshExecutablePriceCents}¢</span>
                                              </span>
                                            )}
                                            {e.authorizedLimitCents != null && (
                                              <span className="text-muted-foreground shrink-0">
                                                authorized ≤<span className="font-mono">{e.authorizedLimitCents}¢</span>
                                              </span>
                                            )}
                                            {/* Seconds left */}
                                            <span className="text-muted-foreground/60 shrink-0">
                                              {e.secondsLeft}s left
                                            </span>
                                            {/* Source tag (only if non-websocket) */}
                                            {e.source !== 'websocket' && (
                                              <span className="text-muted-foreground/50 shrink-0 text-[9px] font-mono">
                                                [{e.source}]
                                              </span>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}

                          {/* Submission audit sub-row */}
                          {latestAudit && (
                            <tr key={`${windowKey}-audit`} className="bg-muted/15">
                              <td colSpan={10} className="px-3 pb-3 pt-1">
                                <div className="rounded-md border border-border/70 bg-background/60 px-3 py-2 text-[11px] text-muted-foreground">
                                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span className="font-semibold text-foreground">Submission audit</span>
                                    <span>{auditSummary}</span>
                                    <span>POST: {latestAudit.postInitiated ? 'sent' : 'not sent'}</span>
                                    <span>Response: {latestAudit.responseReceived ? 'received' : 'not received'}</span>
                                    {latestAudit.httpStatus != null && <span>HTTP {latestAudit.httpStatus}</span>}
                                    {latestAudit.postDurationMs != null && <span>{latestAudit.postDurationMs} ms</span>}
                                  </div>
                                  {(latestAudit.originalExecutablePriceCents != null || latestAudit.finalExecutablePriceCents != null || latestAudit.finalQuoteAgeMs != null) && (
                                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                                      {latestAudit.originalExecutablePriceCents != null && <span>Preflight: {latestAudit.originalExecutablePriceCents}¢</span>}
                                      {latestAudit.finalExecutablePriceCents != null && <span>Final L2: {latestAudit.finalExecutablePriceCents}¢</span>}
                                      {latestAudit.finalPriceDeltaCents != null && <span>Δ {latestAudit.finalPriceDeltaCents}¢</span>}
                                      {latestAudit.finalQuoteAgeMs != null && <span>Quote age: {latestAudit.finalQuoteAgeMs} ms</span>}
                                    </div>
                                  )}
                                  {latestAudit.providerMessage && (
                                    <div className="mt-1 break-words font-mono text-[10px] text-muted-foreground">
                                      Provider: {latestAudit.providerMessage}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ETH 420 boundary audit — server evidence only; no execution controls. */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">ETH 15-Minute Boundary Timeline</div>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-muted text-muted-foreground">READ ONLY</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Fast-discovery evidence for ETH 420 windows · recorded timestamps only · refreshes every 30 s
            </div>
          </div>
          {!boundaryDiscoveryReport ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading boundary evidence…</div>
          ) : !boundaryDiscoveryReport.available ? (
            <div className="px-4 py-6 text-center text-xs text-amber-500">
              Boundary audit evidence is unavailable. No timing or decision outcome is inferred.
            </div>
          ) : boundaryDiscoveryReport.timelines.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No recent ETH boundary audit entries were recorded. This does not imply discovery, evaluation, or submission occurred.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border bg-muted/20">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Official open</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Market</th>
                  {BOUNDARY_TIMELINE_STAGES.map(({ stage, label }) => (
                    <th key={stage} className="px-3 py-2 text-left font-medium text-muted-foreground">{label}</th>
                  ))}
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Blocked / probe outcome</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {boundaryDiscoveryReport.timelines.map((timeline) => {
                    const eventsForStage = (stage: BoundaryDiscoveryStage) =>
                      timeline.events.filter((event) => event.stage === stage);
                    const recordedTime = (event: BoundaryDiscoveryEvent | undefined) =>
                      event
                        ? <span title={new Date(event.atMs).toISOString()} className="font-mono tabular-nums text-foreground">{new Date(event.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        : <span className="text-muted-foreground/60">not recorded</span>;
                    const outcomes = timeline.events.filter((event) =>
                      event.stage === 'executor_blocked' || event.stage === 'probe_deferred' || event.stage === 'probe_exhausted',
                    );
                    return (
                      <tr key={`${timeline.ticker}-${timeline.openTimeMs}`} className="hover:bg-muted/10">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="font-mono tabular-nums">{new Date(timeline.openTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                          <div className="text-[10px] text-muted-foreground">{new Date(timeline.openTimeMs).toLocaleDateString()}</div>
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px] whitespace-nowrap">{timeline.ticker}</td>
                        {BOUNDARY_TIMELINE_STAGES.map(({ stage }) => {
                          const events = eventsForStage(stage);
                          const latest = events.at(-1);
                          return <td key={stage} className="px-3 py-2 whitespace-nowrap">
                            {recordedTime(latest)}
                            {latest?.reason && <div className="text-[10px] text-muted-foreground">{latest.reason.replaceAll('_', ' ')}</div>}
                            {stage === 'active_response' && latest && (
                              <div className={cn(
                                'text-[10px]',
                                timeline.metadataState === 'usable' ? 'text-chart-3' : 'text-amber-500',
                              )}>
                                {timeline.metadataState === 'usable'
                                  ? `metadata usable · ${new Date(eventsForStage('usable_metadata').at(-1)!.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                                  : 'metadata unavailable'}
                              </div>
                            )}
                          </td>;
                        })}
                        <td className="px-3 py-2 min-w-48">
                          {outcomes.length === 0 ? (
                            <span className="text-muted-foreground/60">not recorded</span>
                          ) : outcomes.map((event, index) => (
                            <div key={`${event.stage}-${event.atMs}-${index}`} className="mb-0.5">
                              <span className="font-medium text-amber-500">{boundaryStageLabel(event.stage)}</span>
                              {' · '}<span className="font-mono">{new Date(event.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                              {event.reason && <span className="text-muted-foreground"> · {event.reason.replaceAll('_', ' ')}</span>}
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {boundaryDiscoveryReport?.available && boundaryDiscoveryReport.timelines.length > 0 && (
            <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
              “Not recorded” means this audit ledger contains no event for that stage; it is not treated as a success, failure, or no-order decision.
            </div>
          )}
        </div>

        {/* P&L by Price Band */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">Mandelbrot Instability Research</div>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-muted text-muted-foreground">RESEARCH ONLY</span>
              {mandelbrotReport && (
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-bold',
                  mandelbrotReport.captureEnabled ? 'bg-chart-3/15 text-chart-3' : 'bg-muted text-muted-foreground',
                )}>{mandelbrotReport.captureEnabled ? 'CAPTURE ON' : 'CAPTURE OFF'}</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Passive BTC/ETH 15-minute observation study. It never affects entries, exits, sizing, or order submission.
            </div>
          </div>
          {!mandelbrotReport ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading research status…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border">
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Observations</div><div className="font-mono text-sm">{mandelbrotReport.observationCount}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Reconciled fills</div><div className="font-mono text-sm">{mandelbrotReport.totalReconciledFills}/{mandelbrotReport.totalFills}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Completeness</div><div className="font-mono text-sm">{mandelbrotReport.reconciliationCompleteness == null ? 'Unknown' : `${(mandelbrotReport.reconciliationCompleteness * 100).toFixed(0)}%`}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Writer health</div><div className={cn('font-mono text-sm', mandelbrotReport.captureStatus.failedWrites || mandelbrotReport.captureStatus.queueDrops ? 'text-destructive' : '')}>{mandelbrotReport.captureStatus.successfulWrites} ok · {mandelbrotReport.captureStatus.queueDepth} queued</div></div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border bg-muted/20">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Score</th><th className="text-right px-3 py-2 font-medium text-muted-foreground">Samples</th><th className="text-right px-3 py-2 font-medium text-muted-foreground">Reconciled</th><th className="text-right px-3 py-2 font-medium text-muted-foreground">Win rate</th><th className="text-right px-3 py-2 font-medium text-muted-foreground">Net P&amp;L</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border">{mandelbrotReport.buckets.map((bucket) => <tr key={bucket.label}>
                    <td className="px-3 py-2 font-mono">{bucket.label}</td><td className="px-3 py-2 text-right tabular-nums">{bucket.sampleCount}</td><td className="px-3 py-2 text-right tabular-nums">{bucket.reconciledFillCount}/{bucket.filledCount}</td><td className="px-3 py-2 text-right tabular-nums">{bucket.winRate == null ? 'Unknown' : `${(bucket.winRate * 100).toFixed(1)}%`}</td><td className="px-3 py-2 text-right font-mono">{bucket.netPnlDollars == null ? 'Unknown' : formatSignedUsd(bucket.netPnlDollars)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
                Spread quality: {mandelbrotReport.spreadQualityCounts.bbo_derived} BBO-derived · {mandelbrotReport.spreadQualityCounts.l2_snapshot} L2 snapshots · {mandelbrotReport.spreadQualityCounts.unavailable} unavailable. Depth and post-entry movement remain unknown when not observed; unknown is not zero.
                {(mandelbrotReport.captureStatus.failedWrites > 0 || mandelbrotReport.captureStatus.queueDrops > 0) && <span className="ml-2 text-destructive">Writer failures: {mandelbrotReport.captureStatus.failedWrites} · dropped: {mandelbrotReport.captureStatus.queueDrops}{mandelbrotReport.captureStatus.lastError ? ` · ${mandelbrotReport.captureStatus.lastError}` : ''}</span>}
              </div>
            </>
          )}
        </div>

        {/* ETH 30–50 strategy-only report */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">ETH 30–50 Strategy</div>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-chart-2/15 text-chart-2">ETH_30_50 ONLY</span>
              {eth30Report && eth30Report.feesIncluded
                ? <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-chart-3/15 text-chart-3">NET OF FEES</span>
                : <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-muted text-muted-foreground">{eth30Report && eth30Report.summary.tickersWithFills > 0 ? 'FEES PARTIAL' : 'GROSS OF FEES'}</span>
              }
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Fills, settlements, and exact P&amp;L computed exclusively from ETH_30_50 ownership ledgers — legacy ETH orders are never attributed to this strategy.
            </div>
          </div>
          {!eth30Report ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading ETH 30–50 report…</div>
          ) : eth30Report.summary.claimedTickers === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">No ETH 30–50 activity yet — the strategy has not claimed any markets.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border">
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Claimed markets</div><div className="font-mono text-sm">{eth30Report.summary.claimedTickers} ({eth30Report.summary.tickersWithFills} filled)</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Entry cost</div><div className="font-mono text-sm">{formatSignedUsd(-eth30Report.summary.entryCostCents / 100)}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Exits + settlements</div><div className="font-mono text-sm">{formatSignedUsd((eth30Report.summary.exitProceedsCents + eth30Report.summary.settlementPayoutCents) / 100)}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Fees paid</div><div className="font-mono text-sm text-muted-foreground">{(eth30Report.summary.totalFeeCents ?? 0) > 0 ? formatSignedUsd(-(eth30Report.summary.totalFeeCents ?? 0) / 100) : '—'}{!eth30Report.feesIncluded && eth30Report.summary.tickersWithFills > 0 && <span className="ml-1 text-[9px] text-amber-500">partial</span>}</div></div>
                <div className="bg-background px-4 py-3">
                  <div className="text-[10px] text-muted-foreground uppercase">{eth30Report.feesIncluded ? 'Net P&L' : 'Gross P&L'}</div>
                  {(() => {
                    const pnl = eth30Report.feesIncluded
                      ? (eth30Report.summary.netPnlCents ?? eth30Report.summary.realizedPnlCents)
                      : eth30Report.summary.realizedPnlCents;
                    return pnl == null ? (
                      <div className="font-mono text-[10px] text-amber-500">verification pending</div>
                    ) : (
                      <div className={cn('font-mono text-sm', pnl > 0 ? 'text-chart-3' : pnl < 0 ? 'text-destructive' : '')}>
                        {formatSignedUsd(pnl / 100)}
                      </div>
                    );
                  })()}
                </div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Settled</div><div className="font-mono text-sm">{eth30Report.summary.settledTickers} ({eth30Report.summary.wins}W/{eth30Report.summary.losses}L) · {eth30Report.summary.openContracts} open</div></div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border bg-muted/20">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Market</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Side</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Entry fills</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Exit fills</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Settlement</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">First 50¢</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Fees</th>
                    {!eth30Report.feesIncluded && <th className="text-right px-3 py-2 font-medium text-muted-foreground">Gross P&L</th>}
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                      {eth30Report.feesIncluded ? 'Net P&L' : <span>Net P&L <span className="text-amber-500">*</span></span>}
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Status</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border">{(() => {
                    // Group tickers by ISO week (Mon–Sun) using easternDate (claim date).
                    // getWeekMonday / groupTickersByWeek are imported from @/lib/eth30WeekGroup
                    // so the same logic is covered by unit tests in Dashboard.eth30WeekGroup.test.ts.
                    const weekLabel = (mondayKey: string): string => {
                      const d = new Date(mondayKey + 'T12:00:00');
                      return 'Week of ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    };

                    // computeEth30WeeklyRunningTotals owns the accumulation logic so that
                    // unit tests in eth30WeekRunning.test.ts can import and exercise the
                    // exact same code path (not a test-local reimplementation).
                    const weeklyRunning = computeEth30WeeklyRunningTotals(eth30Report.tickers);

                    const colCount = eth30Report.feesIncluded ? 9 : 10;

                    return weeklyRunning.map(({ weekKey, rows, weekSummary,
                                               runningNetPnl: runningSnap,
                                               runningIsPartial: runningSnapIsPartial }) => {
                      const weekFilled = rows.filter(r => r.entryContracts > 0);
                      const { grossPnl: weekGrossPnl, netPnl: weekNetPnl, fees: weekFees,
                              allFeesIncluded: weekAllFeesIncluded, anyFeesCaptured: weekAnyFeeCaptured,
                              wins: weekWins, losses: weekLosses } = weekSummary;
                      const weekSettled = weekFilled.filter(r => r.status === 'settled');

                      const weekNetColor = weekAllFeesIncluded && weekNetPnl !== null
                        ? (weekNetPnl > 0 ? 'text-chart-3' : weekNetPnl < 0 ? 'text-destructive' : 'text-muted-foreground')
                        : 'text-muted-foreground';
                      const runningColor = !runningSnapIsPartial
                        ? (runningSnap > 0 ? 'text-chart-3' : runningSnap < 0 ? 'text-destructive' : 'text-muted-foreground')
                        : 'text-muted-foreground';

                      return (
                        <Fragment key={weekKey}>
                          {/* Week header row */}
                          <tr className="bg-muted/40 border-y border-border/60">
                            <td colSpan={colCount} className="px-3 py-1.5">
                              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{weekLabel(weekKey)}</span>
                              <span className="ml-2 text-[10px] text-muted-foreground">
                                {rows.length} market{rows.length !== 1 ? 's' : ''}
                                {weekFilled.length > 0 && weekFilled.length !== rows.length ? ` · ${weekFilled.length} filled` : ''}
                              </span>
                            </td>
                          </tr>
                          {/* Individual ticker rows */}
                          {rows.map((row) => {
                            const grossPnl = row.realizedPnlCents;
                            const netPnl = row.netPnlCents;
                            const grossColor = (grossPnl ?? 0) > 0 ? 'text-chart-3' : (grossPnl ?? 0) < 0 ? 'text-destructive' : '';
                            const netColor = (netPnl ?? grossPnl ?? 0) > 0 ? 'text-chart-3' : (netPnl ?? grossPnl ?? 0) < 0 ? 'text-destructive' : '';
                            return (
                              <tr key={row.ticker}>
                                <td className="px-3 py-2 font-mono">{row.ticker}<span className="ml-2 text-muted-foreground">{row.easternDate}</span></td>
                                <td className="px-3 py-2 uppercase">{row.side ?? '—'}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{row.entryContracts > 0 ? `${row.entryContracts} @ ${row.entryAvgPriceCents}¢ avg` : '—'}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{row.exitContracts > 0 ? `${row.exitContracts} (${formatSignedUsd(row.exitProceedsCents / 100)})` : '—'}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{row.settlementResult ? `${row.settlementResult.toUpperCase()} · ${row.settledContracts} @ ${row.settlementPayoutCents > 0 ? '100¢' : '0¢'}` : '—'}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{row.firstExecutable50AtMs ? new Date(row.firstExecutable50AtMs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) : '—'}</td>
                                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                  {row.entryContracts > 0
                                    ? row.anyFeesCaptured
                                      ? formatSignedUsd(-(row.totalFeeCents ?? 0) / 100)
                                      : <span className="text-amber-500/70 text-[10px]">not loaded</span>
                                    : '—'}
                                </td>
                                {!eth30Report.feesIncluded && (
                                  <td className={cn('px-3 py-2 text-right font-mono', grossColor)}>{row.entryContracts > 0 ? grossPnl == null ? 'verification pending' : formatSignedUsd(grossPnl / 100) : '—'}</td>
                                )}
                                <td className={cn('px-3 py-2 text-right font-mono', row.feesIncluded ? netColor : row.anyFeesCaptured ? netColor : 'text-muted-foreground')}>
                                  {row.entryContracts > 0
                                    ? row.feesIncluded
                                      ? netPnl == null ? 'verification pending' : formatSignedUsd(netPnl / 100)
                                      : row.anyFeesCaptured
                                        ? <span>{netPnl == null ? 'verification pending' : formatSignedUsd(netPnl / 100)} <span className="text-amber-500 text-[9px]">partial</span></span>
                                        : <span className="text-amber-500/70 text-[10px]">not loaded</span>
                                    : '—'}
                                </td>
                                <td className="px-3 py-2 text-right"><span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold',
                                  row.status === 'settled' ? 'bg-chart-3/15 text-chart-3' :
                                  row.status === 'open' ? 'bg-chart-2/15 text-chart-2' : 'bg-muted text-muted-foreground',
                                )}>{row.status.replace('_', ' ').toUpperCase()}</span></td>
                              </tr>
                            );
                          })}
                          {/* Week subtotal row (only when there are filled markets) */}
                          {weekFilled.length > 0 && (
                            <tr className="bg-muted/20">
                              <td className="px-3 py-1.5 text-[10px] text-muted-foreground italic" colSpan={6}>
                                Subtotal · {weekFilled.length} filled
                                {weekSettled.length > 0
                                  ? <> · {weekSettled.length} settled ({weekWins}W/{weekLosses}L)</>
                                  : <> · none settled</>}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-[10px] text-muted-foreground">
                                {weekAllFeesIncluded
                                  ? formatSignedUsd(-weekFees / 100)
                                  : weekAnyFeeCaptured
                                    ? <span>{formatSignedUsd(-weekFees / 100)} <span className="text-amber-500 text-[9px]">partial</span></span>
                                    : <span className="text-amber-500/70">not loaded</span>}
                              </td>
                              {!eth30Report.feesIncluded && (
                                <td className={cn('px-3 py-1.5 text-right font-mono text-[10px]', (weekGrossPnl ?? 0) > 0 ? 'text-chart-3' : (weekGrossPnl ?? 0) < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                                  {weekGrossPnl == null ? 'verification pending' : formatSignedUsd(weekGrossPnl / 100)}
                                </td>
                              )}
                              <td className={cn('px-3 py-1.5 text-right font-mono text-[10px]', weekNetColor)}>
                                {weekAllFeesIncluded && weekNetPnl !== null
                                  ? formatSignedUsd(weekNetPnl / 100)
                                  : weekAnyFeeCaptured
                                    ? <span>{weekGrossPnl == null ? 'verification pending' : formatSignedUsd(weekGrossPnl / 100)} <span className="text-amber-500 text-[9px]">partial</span></span>
                                    : weekGrossPnl == null ? 'verification pending' : formatSignedUsd(weekGrossPnl / 100)}
                                <span
                                  className={cn('ml-2 text-[9px] opacity-70', runningColor)}
                                  title={`Cumulative net P&L through this week${runningSnapIsPartial ? ' (partial — some fees not yet loaded)' : ''}`}
                                >
                                  ∑{formatSignedUsd(runningSnap / 100)}{runningSnapIsPartial && <span className="text-amber-500 ml-0.5">~</span>}
                                </span>
                              </td>
                              <td className="px-3 py-1.5" />
                            </tr>
                          )}
                        </Fragment>
                      );
                    });
                  })()}</tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
                {eth30Report.feesIncluded
                  ? <>Net P&amp;L = exit proceeds + settlement payout − entry cost − exchange fees.</>
                  : <><span className="text-amber-500">*</span> Net P&amp;L column shows partial estimates — exchange fees are{eth30Report.summary.tickersWithFills > 0 && (eth30Report.summary.totalFeeCents ?? 0) > 0 ? ' partially' : ' not yet'} available from the Kalshi fills API. Gross P&amp;L (before fees) is always accurate. Rows with no fee data show <span className="text-amber-500/70">not loaded</span> in the Fees column.</>
                }{' '}"First 50¢" is the first observed moment the resting 50¢ target became executable (Eastern time).
              </div>
            </>
          )}
        </div>

        {/* ETH 21–25¢ → 50¢ prospective passive cohort */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-foreground">ETH 21–25¢ → 50¢ Prospective Cohort</div>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-chart-4/15 text-chart-4">PASSIVE RESEARCH</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-muted text-muted-foreground">NO ORDER CAPABILITY</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Independent $10 hypothetical cohort. It observes the live ETH feed but cannot claim, place, cancel, or modify orders.</div>
          </div>
          {!eth2125Prospective ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading prospective cohort…</div>
          ) : (
            <>
              {/* Summary metrics */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border">
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Eligible trades</div><div className="font-mono text-sm">{eth2125Prospective.summary.eligibleTrades}/{eth2125Prospective.reviewGateTrades}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">50¢ target rate</div><div className="font-mono text-sm">{eth2125Prospective.summary.targetHitRate == null ? '—' : `${(eth2125Prospective.summary.targetHitRate * 100).toFixed(1)}%`}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">W / L</div><div className="font-mono text-sm">{eth2125Prospective.summary.wins}W / {eth2125Prospective.summary.losses}L</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Net P&amp;L</div><div className={cn('font-mono text-sm', eth2125Prospective.summary.netPnlCents > 0 ? 'text-chart-3' : eth2125Prospective.summary.netPnlCents < 0 ? 'text-destructive' : '')}>{formatSignedUsd(eth2125Prospective.summary.netPnlCents / 100)}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Max drawdown</div><div className="font-mono text-sm text-destructive">{formatSignedUsd(-eth2125Prospective.summary.maxDrawdownCents / 100)}</div></div>
                <div className="bg-background px-4 py-3"><div className="text-[10px] text-muted-foreground uppercase">Review gate</div><div className={cn('font-mono text-sm', eth2125Prospective.summary.reviewReady ? 'text-chart-3' : 'text-muted-foreground')}>{eth2125Prospective.summary.reviewReady ? 'READY' : `${eth2125Prospective.reviewGateTrades - eth2125Prospective.summary.eligibleTrades} to go`}</div></div>
              </div>

              {/* Depth-audit summary */}
              <div className="border-t border-border">
                <div className="px-4 pt-3 pb-1 flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">50¢ depth audit</span>
                  {eth2125Prospective.summary.reviewReady && !eth2125Prospective.summary.reviewEvidenceComplete && (
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-amber-500/15 text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> EVIDENCE INCOMPLETE
                    </span>
                  )}
                  {eth2125Prospective.summary.reviewEvidenceComplete && (
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-chart-3/15 text-chart-3">EVIDENCE COMPLETE</span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-px bg-border mx-4 mb-3 rounded overflow-hidden">
                  <div className="bg-background px-3 py-2">
                    <div className="text-[10px] text-muted-foreground uppercase">Depth confirmed</div>
                    <div className="font-mono text-sm text-chart-3">{eth2125Prospective.summary.targetHitsDepthConfirmed}</div>
                    <div className="text-[10px] text-muted-foreground">hit at full size</div>
                  </div>
                  <div className="bg-background px-3 py-2">
                    <div className="text-[10px] text-muted-foreground uppercase">Insufficient depth</div>
                    <div className="font-mono text-sm text-amber-400">{eth2125Prospective.summary.targetHitsInsufficientDepth}</div>
                    <div className="text-[10px] text-muted-foreground">touched, depth short</div>
                  </div>
                  <div className="bg-background px-3 py-2">
                    <div className="text-[10px] text-muted-foreground uppercase">BBO touch only</div>
                    <div className="font-mono text-sm text-destructive">{eth2125Prospective.summary.targetHitsBboTouchOnly}</div>
                    <div className="text-[10px] text-muted-foreground">no depth data</div>
                  </div>
                </div>
              </div>

              {/* Per-row depth classification table */}
              {eth2125Prospective.rows.length > 0 && (
                <div className="border-t border-border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/20">
                        <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-muted-foreground">Ticker</th>
                        <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-muted-foreground">Side</th>
                        <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase text-muted-foreground">Entry</th>
                        <th className="px-3 py-2 text-center text-[10px] font-semibold uppercase text-muted-foreground">50¢ depth verdict</th>
                        <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase text-muted-foreground">Max depth</th>
                        <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase text-muted-foreground">Snapshots</th>
                        <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase text-muted-foreground">Net P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {eth2125Prospective.rows.map((row) => {
                        const { classification, maxContractsAtOrAboveTarget, snapshotCount, usableSnapshotCount } = row.depthAudit;
                        const verdictLabel =
                          classification === 'depth_confirmed'    ? 'Depth confirmed' :
                          classification === 'insufficient_depth' ? 'Insufficient depth' :
                          classification === 'bbo_touch_only'     ? 'BBO touch only' :
                          'Not reached';
                        const verdictClass =
                          classification === 'depth_confirmed'    ? 'bg-chart-3/15 text-chart-3' :
                          classification === 'insufficient_depth' ? 'bg-amber-500/15 text-amber-400' :
                          classification === 'bbo_touch_only'     ? 'bg-destructive/15 text-destructive' :
                          'bg-muted text-muted-foreground';
                        return (
                          <tr key={row.ticker} className="hover:bg-muted/10">
                            <td className="px-3 py-2 font-mono text-[11px]">{row.ticker}</td>
                            <td className="px-3 py-2 uppercase text-[10px] font-bold text-muted-foreground">{row.side}</td>
                            <td className="px-3 py-2 text-right font-mono">{row.entryPriceCents}¢</td>
                            <td className="px-3 py-2 text-center">
                              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', verdictClass)}>
                                {verdictLabel}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {maxContractsAtOrAboveTarget != null ? maxContractsAtOrAboveTarget : '—'}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {usableSnapshotCount}/{snapshotCount}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {row.netPnlCents == null
                                ? <span className="text-muted-foreground">open</span>
                                : <span className={row.netPnlCents >= 0 ? 'text-chart-3' : 'text-destructive'}>{formatSignedUsd(row.netPnlCents / 100)}</span>
                              }
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
                Frozen historical benchmark: {eth2125Prospective.benchmark.trades} trades · {eth2125Prospective.benchmark.wins}W/{eth2125Prospective.benchmark.losses}L · {(eth2125Prospective.benchmark.targetHitRate * 100).toFixed(1)}% authenticated 50¢ target rate · {formatSignedUsd(eth2125Prospective.benchmark.netPnlCents / 100)} net at $10 · {formatSignedUsd(-eth2125Prospective.benchmark.maxDrawdownCents / 100)} max drawdown. Fees shown for this prospective cohort are estimated; no fills are submitted.
                {' '}Depth verdict: <span className="text-chart-3">confirmed</span> = L2 book showed ≥ hypothetical size at 50¢ in ≥1 usable snapshot; <span className="text-amber-400">insufficient</span> = touched but depth fell short; <span className="text-destructive">BBO touch only</span> = no L2 evidence captured.
              </div>
            </>
          )}
        </div>

        {/* ETH 30–50 Target-Liquidity Diagnosis */}
        <TargetLiquidityPanel
          label="ETH 30–50 Target-Liquidity Diagnosis"
          badge={{ text: 'ETH_30_50 ONLY', color: 'bg-chart-2/15 text-chart-2' }}
          report={eth30TargetLiquidity}
          isLive={
            eth30TargetLiquidity?.positions.some(
              (p) => p.openContracts > 0 && p.classification !== 'target_filled',
            ) ?? false
          }
        />

        {/* SOL 30–50 Target-Liquidity Diagnosis */}
        <TargetLiquidityPanel
          label="SOL 30–50 Target-Liquidity Diagnosis"
          badge={{ text: 'SOL_30_50 ONLY', color: 'bg-chart-4/15 text-chart-4' }}
          report={sol30TargetLiquidity}
          isLive={
            sol30TargetLiquidity?.positions.some(
              (p) => p.openContracts > 0 && p.classification !== 'target_filled',
            ) ?? false
          }
        />

        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">P&amp;L by Price Band</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Win rate and net P&amp;L per fill-price band · refreshes every 60 s
                {pnlReport && (() => {
                  const executedTrades = pnlReport.summary.fills + pnlReport.pending.fillsPending;
                  return (
                    <span className="ml-2">
                      · <span className="font-medium text-foreground">{executedTrades} executed trade{executedTrades !== 1 ? 's' : ''}</span>
                      {pnlReport.pending.fillsPending > 0 && ' (includes pending settlement)'}
                    </span>
                  );
                })()}
                {pnlReport?.pending && pnlReport.pending.fillsPending > 0 && (
                  <span className="ml-2 text-amber-500">
                    · {pnlReport.pending.fillsPending} fill{pnlReport.pending.fillsPending !== 1 ? 's' : ''} awaiting settlement
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-1">
              {(['today', '7d', 'all-time'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPnlPeriod(p)}
                  className={cn(
                    'px-2 py-1 text-xs rounded transition-colors',
                    pnlPeriod === p
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {!pnlReport ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</div>
          ) : (() => {
            const activeBands = pnlReport.byBand.filter((b) => b.fills > 0);
            const estimatedCount = pnlReport.estimatedFillCount ?? 0;
            if (activeBands.length === 0) {
              return (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No settled fills for this period yet.
                </div>
              );
            }
            return (
              <div>
                {/* Reconciliation status banner — shown whenever the total is not yet
                    confirmed against the Kalshi fills API.  Replaces and extends the
                    previous estimated-fill-only warning. */}
                {pnlReport.reconciliationStatus === "reconstructed" && (() => {
                  const rc = pnlReport.reconciliation;
                  const parts: string[] = [];
                  if (rc) {
                    if (rc.estimatedPrice > 0)
                      parts.push(`${rc.estimatedPrice} estimated-price fill${rc.estimatedPrice !== 1 ? 's' : ''}`);
                    if (rc.pendingReconciliation > 0)
                      parts.push(`${rc.pendingReconciliation} in-flight fill${rc.pendingReconciliation !== 1 ? 's' : ''}`);
                    if (rc.pendingSettlement > 0)
                      parts.push(`${rc.pendingSettlement} awaiting settlement`);
                  } else if (estimatedCount > 0) {
                    parts.push(`${estimatedCount} estimated-price fill${estimatedCount !== 1 ? 's' : ''}`);
                  }
                  // Use the authoritative child-fill ledger for the confirmed
                  // subtotal — not the parent-record derived value, which can
                  // diverge from exact exchange fill economics.
                  const ledgerConfirmed = pnlReport.verified?.combined?.realizedNetPnlDollars ?? null;
                  return (
                    <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/25 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        <span className="font-semibold">Preliminary total</span>
                        {parts.length > 0 && (
                          <> — {parts.join(', ')}. P&amp;L may differ from the exchange record.</>
                        )}
                        {ledgerConfirmed != null && rc && rc.reportedNetPnlDollars != null && (
                          <span className="ml-2 text-amber-500/80">
                            Confirmed: {ledgerConfirmed >= 0 ? '+' : ''}${ledgerConfirmed.toFixed(2)} of reported ${rc.reportedNetPnlDollars.toFixed(2)}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })()}
                {pnlReport.reconciliationStatus === "exchange_reconciled" && activeBands.length > 0 && (
                  <div className="px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/25 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    Exchange reconciled — all fill prices confirmed from Kalshi
                  </div>
                )}
                {/* Legacy warning for older API responses that lack reconciliationStatus */}
                {pnlReport.reconciliationStatus == null && estimatedCount > 0 && (
                  <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/25 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      <span className="font-semibold">{estimatedCount} fill{estimatedCount !== 1 ? 's' : ''}</span> used an estimated fill price — reconciliation permanently failed for {estimatedCount !== 1 ? 'these orders' : 'this order'}. P&amp;L figures may be inaccurate.
                    </span>
                  </div>
                )}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/20">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Band (¢)</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Fills</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">W / L</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Win %</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Net P&amp;L</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">ROI</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pnlReport.byBand.map((band) => {
                      const winPct = band.winRate != null ? (band.winRate * 100).toFixed(1) : null;
                      const pnlColor = band.netPnlDollars == null ? '' :
                        band.netPnlDollars > 0 ? 'text-chart-3' :
                        band.netPnlDollars < 0 ? 'text-destructive' : 'text-muted-foreground';
                      const winColor = band.winRate == null ? '' :
                        band.winRate >= 0.5 ? 'text-chart-3' :
                        band.winRate >= 0.4 ? 'text-amber-500' : 'text-destructive';
                      return (
                        <tr key={band.band} className={cn('hover:bg-muted/20 transition-colors', band.fills === 0 ? 'opacity-40' : '')}>
                          <td className="px-3 py-2 font-mono text-foreground">{band.band}¢</td>
                          <td className="px-3 py-2 text-right tabular-nums text-foreground">
                            {band.fills > 0 ? band.fills : '—'}
                            {band.sampleWarning === 'very_small' && band.fills > 0 && (
                              <span className="ml-1 text-amber-500/70 text-[10px]">*</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {band.fills > 0 ? `${band.wins}/${band.losses}` : '—'}
                          </td>
                          <td className={cn('px-3 py-2 text-right tabular-nums font-medium', winColor)}>
                            {winPct != null ? `${winPct}%` : '—'}
                          </td>
                          <td className={cn('px-3 py-2 text-right tabular-nums font-mono font-medium', pnlColor)}>
                            {band.netPnlDollars != null
                              ? formatSignedUsd(band.netPnlDollars)
                              : '—'}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground font-mono hidden md:table-cell">
                            {band.roi != null ? `${(band.roi * 100).toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {pnlReport.byAsset.length > 0 && (() => {
                    const combined = pnlReport.byAsset.find((a) => a.asset === 'combined');
                    if (!combined || combined.fills === 0) return null;
                    const wPct = combined.winRate != null ? (combined.winRate * 100).toFixed(1) : null;
                    const pColor = combined.netPnlDollars == null ? 'text-muted-foreground' :
                      combined.netPnlDollars > 0 ? 'text-chart-3' :
                      combined.netPnlDollars < 0 ? 'text-destructive' : 'text-muted-foreground';
                    return (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/10 font-medium">
                          <td className="px-3 py-2 text-foreground">All bands</td>
                          <td className="px-3 py-2 text-right tabular-nums text-foreground">{combined.fills}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{combined.wins}/{combined.fills - combined.wins}</td>
                          <td className={cn('px-3 py-2 text-right tabular-nums', wPct && combined.winRate! >= 0.5 ? 'text-chart-3' : combined.winRate! >= 0.4 ? 'text-amber-500' : 'text-destructive')}>
                            {wPct != null ? `${wPct}%` : '—'}
                          </td>
                          <td className={cn('px-3 py-2 text-right tabular-nums font-mono', pColor)}>
                            {combined.netPnlDollars != null ? formatSignedUsd(combined.netPnlDollars) : '—'}
                          </td>
                          <td className="hidden md:table-cell" />
                        </tr>
                      </tfoot>
                    );
                  })()}
                </table>
                {pnlReport.byBand.some((b) => b.sampleWarning === 'very_small' && b.fills > 0) && (
                  <div className="px-4 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
                    * fewer than 30 fills — results are preliminary
                  </div>
                )}
              </div>
              </div>
            );
          })()}
        </div>

        {/* Win Rate by Time of Day */}
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-muted/30 border-b border-border">
            <div className="text-sm font-semibold text-foreground">Win Rate by Time of Day</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Settled fills grouped by Eastern time-of-day bucket · uses the P&amp;L period selected above ({pnlPeriod})
            </div>
          </div>

          {!pnlReport ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</div>
          ) : (() => {
            const buckets = pnlReport.byTimeOfDay ?? [];
            if (buckets.every((b) => b.combined.fills === 0)) {
              return (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No settled fills for this period yet.
                </div>
              );
            }
            const statCells = (s: TimeOfDayStats, keyPrefix: string) => {
              const winPct = s.winRate != null ? (s.winRate * 100).toFixed(0) : null;
              const winColor = s.winRate == null ? '' :
                s.winRate >= 0.5 ? 'text-chart-3' :
                s.winRate >= 0.4 ? 'text-amber-500' : 'text-destructive';
              const pnlColor = s.netPnlDollars == null ? '' :
                s.netPnlDollars > 0 ? 'text-chart-3' :
                s.netPnlDollars < 0 ? 'text-destructive' : 'text-muted-foreground';
              return (
                <>
                  <td key={`${keyPrefix}-wl`} className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {s.fills > 0 ? `${s.wins}/${s.losses}` : '—'}
                    {s.sampleWarning === 'very_small' && s.fills > 0 && (
                      <span className="ml-1 text-amber-500/70 text-[10px]">*</span>
                    )}
                  </td>
                  <td key={`${keyPrefix}-win`} className={cn('px-3 py-2 text-right tabular-nums font-medium', winColor)}>
                    {winPct != null ? `${winPct}%` : '—'}
                  </td>
                  <td key={`${keyPrefix}-pnl`} className={cn('px-3 py-2 text-right tabular-nums font-mono', pnlColor)}>
                    {s.netPnlDollars != null ? formatSignedUsd(s.netPnlDollars) : '—'}
                  </td>
                </>
              );
            };
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/20">
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground" />
                      <th colSpan={3} className="text-center px-3 py-1.5 font-medium text-muted-foreground border-l border-border">All</th>
                      <th colSpan={3} className="text-center px-3 py-1.5 font-medium text-muted-foreground border-l border-border">BTC</th>
                      <th colSpan={3} className="text-center px-3 py-1.5 font-medium text-muted-foreground border-l border-border">ETH</th>
                    </tr>
                    <tr className="border-b border-border bg-muted/20">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Window (ET)</th>
                      {(['all', 'btc', 'eth'] as const).map((g) => (
                        <Fragment key={g}>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground border-l border-border">W / L</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Win %</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Net P&amp;L</th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {buckets.map((b) => (
                      <tr key={b.label} className={cn('hover:bg-muted/20 transition-colors', b.combined.fills === 0 ? 'opacity-40' : '')}>
                        <td className="px-3 py-2 text-foreground">{b.label}</td>
                        {statCells(b.combined, `${b.label}-all`)}
                        {statCells(b.btc, `${b.label}-btc`)}
                        {statCells(b.eth, `${b.label}-eth`)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {buckets.some((b) => b.combined.sampleWarning === 'very_small' && b.combined.fills > 0) && (
                  <div className="px-4 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
                    * fewer than 30 fills — results are preliminary
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Preflight Calibration */}
        <PreflightCalibrationPanel />

        {/* Audited replay settlement coverage */}
        <SettlementCoveragePanel />

        {/* Decision-quality evidence */}
        <TradeDecisionEvidencePanel />

        {/* H-002 research sufficiency */}
        <H002EvidenceReadinessPanel />

        {/* Conservative condition recommendations */}
        <ConditionRecommendationsPanel />

        {/* Zero-fill Analysis */}
        <ZeroFillAnalysisPanel />

        {/* Falling-Knife Detector */}
        <FallingKnifePanel />

        {/* Phase 4B entry-gap evidence coverage */}
        <EntryGapCoveragePanel />

        {/* Saturday investor report preview */}
        <WeeklyReportPanel />

        <p className="text-xs text-muted-foreground text-center">
          Prices in cents. Kalshi markets update through the live stream with a five-minute REST fallback. BTC and ETH spot prices refresh every 10 seconds.
        </p>
      </div>
    </Layout>
  );
}

// ─── Weekly Mr. Teal report preview ───────────────────────────────────────────

interface WeeklyReportPreview {
  weekStart: string;
  weekEndExclusive: string;
  generatedAt: string;
  text: string;
  html: string;
  execution: {
    available: boolean;
    filledOrderCount: number;
    ledgerBackedOrderCount: number;
    filledNotionalDollars: number | null;
    feeDollars: number | null;
    preliminaryOrderCount: number;
  };
  realized: { realizedNetPnlDollars: number | null; pendingVerificationCount: number; unverifiedFillCount: number };
}

// ── Target-Liquidity Diagnosis Panel ─────────────────────────────────────────

const CLASSIFICATION_LABEL: Record<string, string> = {
  target_filled:                'Target Filled',
  never_reached_target:         'Never Reached 50¢',
  reached_target_no_depth_data: 'Reached 50¢ — No Depth Data',
  insufficient_depth:           'Insufficient Depth',
  sufficient_depth_unfilled:    'Sufficient Depth — Unfilled',
};

function classificationBadge(c: string) {
  if (c === 'sufficient_depth_unfilled') {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-destructive/15 text-destructive ring-1 ring-destructive/40">
        ⚠ {CLASSIFICATION_LABEL[c] ?? c}
      </span>
    );
  }
  if (c === 'target_filled') {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-chart-3/15 text-chart-3">
        {CLASSIFICATION_LABEL[c] ?? c}
      </span>
    );
  }
  if (c === 'never_reached_target') {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-muted text-muted-foreground">
        {CLASSIFICATION_LABEL[c] ?? c}
      </span>
    );
  }
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-amber-500/15 text-amber-500">
      {CLASSIFICATION_LABEL[c] ?? c}
    </span>
  );
}

// ── Target-liquidity depth snapshot types ──────────────────────────────────

interface TargetLiquidityDepthSnapshot {
  capturedAtMs:             number;
  contractsAtOrAboveTarget: number;
  restingContracts:         number | null;
  observedBidCents:         number | null;
  orderStatus:              string | null;
  bookError:                string | null;
  bidLevelCount:            number;
}

// ── Mini SVG depth-over-time chart ─────────────────────────────────────────

function DepthTimelineChart({ snapshots, targetCents }: {
  snapshots: TargetLiquidityDepthSnapshot[];
  targetCents: number;
}) {
  const usable = snapshots.filter((s) => s.bookError == null);
  if (usable.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic py-4 text-center">
        No usable depth snapshots (all had book-fetch errors).
      </div>
    );
  }

  const W = 560;
  const H = 120;
  const PAD = { top: 12, right: 16, bottom: 28, left: 40 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const times = usable.map((s) => s.capturedAtMs);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tRange = tMax - tMin || 1;

  const maxDepth = Math.max(...usable.map((s) => s.contractsAtOrAboveTarget), 1);
  const maxResting = Math.max(...usable.map((s) => s.restingContracts ?? 0), 0);
  const yMax = Math.max(maxDepth, maxResting, 1);

  const toX = (ms: number) => PAD.left + ((ms - tMin) / tRange) * chartW;
  const toY = (v: number) => PAD.top + chartH - (v / yMax) * chartH;

  // Count consecutive sufficient-depth snapshots to compute gap spans
  const sufficientRuns: Array<{ startMs: number; endMs: number; count: number }> = [];
  let runStart: number | null = null;
  let runCount = 0;
  for (const s of usable) {
    const suf = s.restingContracts != null && s.contractsAtOrAboveTarget >= s.restingContracts;
    if (suf) {
      if (runStart == null) { runStart = s.capturedAtMs; runCount = 0; }
      runCount++;
    } else {
      if (runStart != null) {
        sufficientRuns.push({ startMs: runStart, endMs: s.capturedAtMs, count: runCount });
        runStart = null; runCount = 0;
      }
    }
  }
  if (runStart != null) {
    sufficientRuns.push({ startMs: runStart, endMs: tMax, count: runCount });
  }

  // Summary text
  const totalSufficientSnaps = sufficientRuns.reduce((a, r) => a + r.count, 0);
  const maxRun = sufficientRuns.length > 0
    ? sufficientRuns.reduce((best, r) => r.count > best.count ? r : best, sufficientRuns[0]!)
    : null;
  const spanMs = maxRun ? maxRun.endMs - maxRun.startMs : 0;
  const spanMin = Math.round(spanMs / 60_000);

  // Bar width: evenly distribute or cap at 20px
  const barW = usable.length > 1 ? Math.min(20, chartW / usable.length * 0.7) : 20;

  // X-axis tick labels: up to 5 evenly spaced
  const tickCount = Math.min(usable.length, 5);
  const tickIndices = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i / Math.max(tickCount - 1, 1)) * (usable.length - 1)),
  );

  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: W, display: 'block' }}
        className="overflow-visible"
      >
        {/* Sufficient-depth shaded regions */}
        {sufficientRuns.map((run, i) => (
          <rect
            key={i}
            x={toX(run.startMs) - barW / 2}
            y={PAD.top}
            width={Math.max(toX(run.endMs) - toX(run.startMs) + barW, barW)}
            height={chartH}
            fill="hsl(var(--chart-3) / 0.08)"
          />
        ))}

        {/* Resting-size reference line (dashed orange) */}
        {usable.map((s, i) => {
          if (s.restingContracts == null) return null;
          const x = toX(s.capturedAtMs);
          const y = toY(s.restingContracts);
          const nextX = i + 1 < usable.length ? toX(usable[i + 1]!.capturedAtMs) : x + barW;
          return (
            <line
              key={`rest-${i}`}
              x1={x - barW / 2} y1={y}
              x2={nextX - barW / 2} y2={y}
              stroke="hsl(38 92% 50%)"
              strokeWidth={1.5}
              strokeDasharray="3 2"
            />
          );
        })}

        {/* Depth bars */}
        {usable.map((s, i) => {
          const x = toX(s.capturedAtMs);
          const sufficient = s.restingContracts != null && s.contractsAtOrAboveTarget >= s.restingContracts;
          const barH = (s.contractsAtOrAboveTarget / yMax) * chartH;
          return (
            <rect
              key={i}
              x={x - barW / 2}
              y={toY(s.contractsAtOrAboveTarget)}
              width={barW}
              height={Math.max(barH, 1)}
              rx={2}
              fill={sufficient ? 'hsl(var(--chart-3) / 0.7)' : 'hsl(var(--chart-1) / 0.55)'}
            />
          );
        })}

        {/* Y-axis label */}
        <text x={PAD.left - 6} y={PAD.top} textAnchor="end" fontSize={9} fill="hsl(var(--muted-foreground))">{yMax}</text>
        <text x={PAD.left - 6} y={PAD.top + chartH} textAnchor="end" fontSize={9} fill="hsl(var(--muted-foreground))">0</text>
        <text
          x={8} y={PAD.top + chartH / 2}
          textAnchor="middle" fontSize={9} fill="hsl(var(--muted-foreground))"
          transform={`rotate(-90,8,${PAD.top + chartH / 2})`}
        >
          ct
        </text>

        {/* X-axis baseline */}
        <line x1={PAD.left} y1={PAD.top + chartH} x2={PAD.left + chartW} y2={PAD.top + chartH}
          stroke="hsl(var(--border))" strokeWidth={1} />

        {/* X-axis ticks */}
        {tickIndices.map((idx) => {
          const s = usable[idx]!;
          const x = toX(s.capturedAtMs);
          return (
            <text key={idx} x={x} y={H - 4} textAnchor="middle" fontSize={8} fill="hsl(var(--muted-foreground))">
              {fmtTime(s.capturedAtMs)}
            </text>
          );
        })}

        {/* Legend */}
        <rect x={PAD.left} y={H - 10} width={8} height={8} rx={1} fill="hsl(var(--chart-3) / 0.7)" />
        <text x={PAD.left + 10} y={H - 3} fontSize={8} fill="hsl(var(--muted-foreground))">depth ≥ resting</text>
        <rect x={PAD.left + 90} y={H - 10} width={8} height={8} rx={1} fill="hsl(var(--chart-1) / 0.55)" />
        <text x={PAD.left + 100} y={H - 3} fontSize={8} fill="hsl(var(--muted-foreground))">depth &lt; resting</text>
        <line x1={PAD.left + 185} y1={H - 6} x2={PAD.left + 193} y2={H - 6}
          stroke="hsl(38 92% 50%)" strokeWidth={1.5} strokeDasharray="3 2" />
        <text x={PAD.left + 196} y={H - 3} fontSize={8} fill="hsl(var(--muted-foreground))">resting size ({targetCents}¢ target)</text>
      </svg>

      {/* Gap summary */}
      <div className="text-[11px] text-muted-foreground space-y-0.5 px-1">
        {totalSufficientSnaps === 0 ? (
          <span>Depth never reached resting size across {usable.length} snapshot{usable.length !== 1 ? 's' : ''}.</span>
        ) : (
          <>
            <span className="text-chart-3 font-medium">
              Depth ≥ resting in {totalSufficientSnaps} of {usable.length} snapshots
            </span>
            {maxRun && maxRun.count > 1 && (
              <span className="ml-2 text-muted-foreground">
                (longest run: {maxRun.count} consecutive{spanMin > 0 ? `, ~${spanMin} min` : ''})
              </span>
            )}
          </>
        )}
      </div>

      {/* Snapshot table */}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              <th className="text-left px-2 py-1 font-medium text-muted-foreground">Time</th>
              <th className="text-right px-2 py-1 font-medium text-muted-foreground">Depth @50¢+</th>
              <th className="text-right px-2 py-1 font-medium text-muted-foreground">Resting</th>
              <th className="text-right px-2 py-1 font-medium text-muted-foreground">Bid</th>
              <th className="text-left px-2 py-1 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {usable.map((s) => {
              const sufficient = s.restingContracts != null && s.contractsAtOrAboveTarget >= s.restingContracts;
              return (
                <tr key={s.capturedAtMs} className={sufficient ? 'bg-chart-3/5' : ''}>
                  <td className="px-2 py-1 font-mono tabular-nums text-muted-foreground">
                    {new Date(s.capturedAtMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                  </td>
                  <td className={cn('px-2 py-1 text-right tabular-nums font-mono', sufficient ? 'text-chart-3 font-semibold' : '')}>
                    {s.contractsAtOrAboveTarget} ct
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums font-mono text-muted-foreground">
                    {s.restingContracts != null ? `${s.restingContracts} ct` : '—'}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {s.observedBidCents != null ? `${s.observedBidCents}¢` : '—'}
                  </td>
                  <td className="px-2 py-1">
                    {s.orderStatus
                      ? <span className={cn(
                          'rounded px-1 py-0.5 text-[10px] font-medium',
                          s.orderStatus === 'resting' ? 'bg-chart-2/15 text-chart-2' :
                          s.orderStatus === 'executed' ? 'bg-chart-3/15 text-chart-3' :
                          s.orderStatus === 'canceled' ? 'bg-destructive/15 text-destructive' :
                          'bg-muted text-muted-foreground',
                        )}>{s.orderStatus}</span>
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TargetLiquidityPanel({
  label,
  badge,
  report,
  isLive,
}: {
  label: string;
  badge: { text: string; color: string };
  report: TargetLiquidityReport | null;
  isLive: boolean;
}) {
  const positions = report?.positions ?? [];
  const actionablePositions = positions.filter((p) => p.classification !== 'target_filled');

  // ── Expandable depth-timeline state ──────────────────────────────────────
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [snapshotsByTicker, setSnapshotsByTicker] = useState<Record<string, TargetLiquidityDepthSnapshot[]>>({});
  const [loadingTicker, setLoadingTicker] = useState<string | null>(null);

  const strategySlug = report?.strategy === 'ETH_30_50' ? 'eth30-50'
    : report?.strategy === 'SOL_30_50' ? 'sol30-50'
    : null;

  const handleRowClick = async (ticker: string, snapshotCount: number) => {
    if (snapshotCount === 0) return; // no snapshots to show
    if (expandedTicker === ticker) { setExpandedTicker(null); return; }
    setExpandedTicker(ticker);
    if (snapshotsByTicker[ticker]) return; // already loaded
    if (!strategySlug) return;
    setLoadingTicker(ticker);
    try {
      const url = `/api/trade/analytics/reports/${strategySlug}/target-liquidity/snapshots?ticker=${encodeURIComponent(ticker)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { snapshots: TargetLiquidityDepthSnapshot[] };
        setSnapshotsByTicker((prev) => ({ ...prev, [ticker]: data.snapshots ?? [] }));
      }
    } catch { /* silently ignore */ }
    finally { setLoadingTicker(null); }
  };

  return (
    <div className={cn('border rounded-xl overflow-hidden', isLive ? 'border-chart-3/50' : 'border-border')}>
      <div className="px-4 py-3 bg-muted/30 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-foreground">{label}</div>
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', badge.color)}>{badge.text}</span>
          {isLive && (
            <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-chart-3/15 text-chart-3">
              <span className="h-1.5 w-1.5 rounded-full bg-chart-3 animate-pulse" />
              LIVE · 15 s
            </span>
          )}
          {report && report.summary.sufficientDepthUnfilled > 0 && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-destructive/15 text-destructive ring-1 ring-destructive/40">
              ⚠ {report.summary.sufficientDepthUnfilled} execution problem{report.summary.sufficientDepthUnfilled !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Why each resting 50¢ target did not fill — depth coverage observed at/above the target while it rested.
          {' '}Click any row with snapshots to see the depth timeline.
        </div>
      </div>

      {!report ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading target-liquidity report…</div>
      ) : positions.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No positions recorded yet — the strategy has not placed a resting target.
        </div>
      ) : (
        <>
          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border">
            <div className="bg-background px-4 py-3">
              <div className="text-[10px] text-muted-foreground uppercase">Positions</div>
              <div className="font-mono text-sm">{report.summary.positions}</div>
            </div>
            <div className="bg-background px-4 py-3">
              <div className="text-[10px] text-muted-foreground uppercase">Target filled</div>
              <div className={cn('font-mono text-sm', report.summary.targetFilled > 0 ? 'text-chart-3' : '')}>{report.summary.targetFilled}</div>
            </div>
            <div className="bg-background px-4 py-3">
              <div className="text-[10px] text-muted-foreground uppercase">Never reached</div>
              <div className="font-mono text-sm">{report.summary.neverReachedTarget}</div>
            </div>
            <div className="bg-background px-4 py-3">
              <div className="text-[10px] text-muted-foreground uppercase">Insuff. depth</div>
              <div className={cn('font-mono text-sm', report.summary.insufficientDepth > 0 ? 'text-amber-500' : '')}>{report.summary.insufficientDepth}</div>
            </div>
            <div className="bg-background px-4 py-3">
              <div className="text-[10px] text-muted-foreground uppercase">Exec. problem</div>
              <div className={cn('font-mono text-sm font-bold', report.summary.sufficientDepthUnfilled > 0 ? 'text-destructive' : '')}>{report.summary.sufficientDepthUnfilled}</div>
            </div>
          </div>

          {/* Per-position table — show all positions, highlighting actionable ones */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground w-6"></th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Market</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Side</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Classification</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Max depth @50¢+</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Resting size</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Snapshots</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Order status</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => {
                  const isExecProblem = pos.classification === 'sufficient_depth_unfilled';
                  const hasSnapshots = pos.snapshotCount > 0;
                  const isExpanded = expandedTicker === pos.ticker;
                  const isLoading = loadingTicker === pos.ticker;
                  return (
                    <Fragment key={pos.ticker}>
                      <tr
                        onClick={() => void handleRowClick(pos.ticker, pos.snapshotCount)}
                        className={cn(
                          'border-b border-border transition-colors',
                          hasSnapshots ? 'cursor-pointer' : 'cursor-default',
                          isExecProblem ? 'bg-destructive/5 hover:bg-destructive/10' : 'hover:bg-muted/20',
                          isExpanded ? (isExecProblem ? 'bg-destructive/10' : 'bg-muted/30') : '',
                        )}
                      >
                        <td className="px-3 py-2 text-center text-muted-foreground">
                          {hasSnapshots
                            ? (isExpanded ? <ChevronDown className="w-3 h-3 inline" /> : <ChevronRight className="w-3 h-3 inline" />)
                            : null}
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {pos.ticker}
                          <span className="ml-2 text-muted-foreground">{pos.easternDate}</span>
                        </td>
                        <td className="px-3 py-2 uppercase text-muted-foreground">{pos.side ?? '—'}</td>
                        <td className="px-3 py-2">{classificationBadge(pos.classification)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {pos.maxContractsAtOrAboveTarget != null
                            ? <span className={cn(pos.maxContractsAtOrAboveTarget === 0 ? 'text-muted-foreground' : '')}>
                                {pos.maxContractsAtOrAboveTarget} ct
                              </span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {pos.lastRestingContracts != null
                            ? `${pos.lastRestingContracts} ct`
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {pos.usableSnapshotCount}/{pos.snapshotCount}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {pos.lastOrderStatus
                            ? <span className={cn(
                                'rounded px-1 py-0.5 text-[10px] font-medium',
                                pos.lastOrderStatus === 'resting' ? 'bg-chart-2/15 text-chart-2' :
                                pos.lastOrderStatus === 'executed' ? 'bg-chart-3/15 text-chart-3' :
                                pos.lastOrderStatus === 'canceled' ? 'bg-destructive/15 text-destructive' :
                                'bg-muted text-muted-foreground',
                              )}>
                                {pos.lastOrderStatus}
                              </span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>

                      {/* Expanded depth timeline */}
                      {isExpanded && (
                        <tr className={isExecProblem ? 'bg-destructive/3' : 'bg-muted/10'}>
                          <td colSpan={8} className="px-4 py-4 border-b border-border">
                            {isLoading ? (
                              <div className="text-xs text-muted-foreground py-2">Loading depth snapshots…</div>
                            ) : (
                              <DepthTimelineChart
                                snapshots={snapshotsByTicker[pos.ticker] ?? []}
                                targetCents={report.targetCents}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {actionablePositions.length > 0 && (
            <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
              <span className="text-destructive font-medium">Sufficient depth — unfilled</span>
              {' '}= depth at/above 50¢ covered the resting size in ≥1 snapshot while the target remained open.
              {' '}<span className="text-amber-500">Insufficient depth</span> = bid touched 50¢ but queue was always too thin.
              {' '}Snapshots: usable / total (usable = no book-fetch error).
            </div>
          )}
        </>
      )}
    </div>
  );
}

function WeeklyReportPanel() {
  const [report, setReport] = useState<WeeklyReportPreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const token = await getTradeToken();
        const response = await fetch('/api/report/weekly/preview', {
          cache: 'no-store',
          headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (!response.ok) throw new Error('weekly report unavailable');
        if (alive) setReport(await response.json() as WeeklyReportPreview);
      } catch {
        if (alive) setReport(null);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => { alive = false; };
  }, []);

  const download = useCallback(() => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report.html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `shawshank-weekly-${report.weekEndExclusive}.html`;
    link.click();
    URL.revokeObjectURL(url);
  }, [report]);

  return (
    <section className="border border-border rounded-xl overflow-hidden" data-testid="weekly-report-preview">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Saturday Report — Mr. Teal</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Completed Eastern calendar week. Ledger-confirmed figures are separated from preliminary records.</p>
        </div>
        <button type="button" disabled={!report} onClick={download} className="text-xs border border-border rounded-md px-2.5 py-1.5 hover:bg-muted disabled:opacity-50">
          Download HTML
        </button>
      </div>
      {loading ? <div className="p-4 text-xs text-muted-foreground">Preparing weekly report…</div>
        : !report ? <div className="p-4 text-xs text-destructive">Weekly report preview is unavailable.</div>
          : <div className="p-4 space-y-3">
            <div className="grid sm:grid-cols-4 gap-3 text-xs">
              <div><span className="text-muted-foreground block">Week</span>{report.weekStart} → {report.weekEndExclusive}</div>
              <div><span className="text-muted-foreground block">Executed orders</span>{report.execution.filledOrderCount} ({report.execution.ledgerBackedOrderCount} ledger-backed)</div>
              <div><span className="text-muted-foreground block">Verified notional / fees</span>{report.execution.filledNotionalDollars == null ? 'Unavailable' : `$${report.execution.filledNotionalDollars.toFixed(2)}`} / {report.execution.feeDollars == null ? 'Unavailable' : `$${report.execution.feeDollars.toFixed(2)}`}</div>
              <div><span className="text-muted-foreground block">Verified net P&amp;L</span>{report.realized.realizedNetPnlDollars == null ? 'Withheld pending reconciliation' : formatSignedUsd(report.realized.realizedNetPnlDollars)}</div>
            </div>
            {(report.execution.preliminaryOrderCount > 0 || report.realized.pendingVerificationCount > 0 || report.realized.unverifiedFillCount > 0) && (
              <p className="text-xs text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 rounded-md p-2">
                Preliminary or incomplete evidence is present: {report.execution.preliminaryOrderCount} parent-only fill record(s), {report.realized.pendingVerificationCount} pending verification, {report.realized.unverifiedFillCount} reconciliation failure(s). Final P&amp;L is withheld where necessary.
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-xs font-medium">Read report draft</summary>
              <pre className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground font-sans">{report.text}</pre>
            </details>
          </div>}
    </section>
  );
}

// ─── Replay settlement coverage ───────────────────────────────────────────────

interface SettlementCoverageReport {
  replayId: string;
  population: number;
  durableCovered: number;
  durableUnresolved: number;
  durableStorageTotal: number;
  audit: {
    completedAt: string;
    candidateCount: number;
    insertedCount: number;
    unchangedCount: number;
    unresolvedCount: number;
    errorCount: number;
  };
  readonly: true;
  caveat: string;
  generatedAt: string;
}

interface CompactShadowAssetStatus {
  asset: 'BTC' | 'ETH' | 'SOL';
  snapshot_count: number;
  market_count: number;
  last_snapshot_ms: number | null;
  resolved_outcome_count: number;
  pending_outcome_market_count: number;
  latest_health: { status?: string; connected?: boolean; last_receipt_ms?: number | null; error?: string | null } | null;
}

interface CompactShadowStatus {
  researchOnly: true;
  executionGate: false;
  rawTicksPersisted: false;
  storage: 'healthy' | 'unavailable';
  assets: CompactShadowAssetStatus[];
  normalizedDistanceExperiment?: {
    version: string;
    startMs: number;
    thresholds: { yesAtOrAbove: number; noAtOrBelow: number };
    researchOnly: true;
    executionGate: false;
    cohorts: Array<{
      asset: 'BTC' | 'ETH' | 'combined';
      enrolled_count: number;
      settled_count: number;
      pending_count: number;
      neutral_count: number;
      directional_count: number;
      correct_count: number;
      directional_accuracy: number | null;
      directional_wilson_95: { low: number | null; high: number | null };
      yes_call_count: number;
      yes_accuracy: number | null;
      no_call_count: number;
      no_accuracy: number | null;
      unavailable_without_eligible_enrollment_count: number;
    }>;
  };
}

const SETTLEMENT_COVERAGE_REFRESH_MS = 5 * 60_000;

function SettlementCoveragePanel() {
  const [data, setData] = useState<SettlementCoverageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const response = await fetch('/api/trade/analytics/reports/settlement-coverage', { cache: 'no-store' });
        if (response.ok && alive) {
          setData(await response.json() as SettlementCoverageReport);
          setLastUpdated(new Date());
        }
      } catch { /* a read-only research card must never interrupt the dashboard */ }
      if (alive) setLoading(false);
    };
    void load(true);
    const intervalId = setInterval(() => { void load(false); }, SETTLEMENT_COVERAGE_REFRESH_MS);
    return () => { alive = false; clearInterval(intervalId); };
  }, []);

  if (loading && !data) {
    return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Loading settlement study…</div>;
  }
  if (!data) {
    return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Settlement study is unavailable.</div>;
  }

  const fullyCovered = data.durableUnresolved === 0 && data.durableCovered === data.population;
  const auditDate = new Date(data.audit.completedAt);
  return (
    <section className="border border-border rounded-xl overflow-hidden" aria-labelledby="settlement-study-title">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap items-start gap-3 justify-between">
        <div>
          <div id="settlement-study-title" className="text-sm font-semibold text-foreground">Replay Settlement Study</div>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">{data.caveat}</p>
          {lastUpdated && (
            <p className="text-[10px] text-muted-foreground/60 mt-1 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Verified {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · refreshes every 5 min
            </p>
          )}
        </div>
        <span className={cn(
          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
          fullyCovered ? 'text-chart-3 bg-chart-3/10 border-chart-3/25' : 'text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/25',
        )}>
          {fullyCovered ? 'Complete settlement coverage' : 'Coverage needs attention'}
        </span>
      </div>

      <div className="grid sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border border-b border-border">
        {[
          ['Replay decisions', data.population],
          ['Durably settled', `${data.durableCovered} / ${data.population}`],
          ['Still unresolved', data.durableUnresolved],
          ['Durable results stored', data.durableStorageTotal],
        ].map(([label, value]) => (
          <div key={String(label)} className="px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className={cn('font-mono font-semibold mt-0.5', label === 'Still unresolved' && Number(value) > 0 ? 'text-destructive' : '')}>{value}</div>
          </div>
        ))}
      </div>

      <div className="p-4 grid md:grid-cols-3 gap-3 text-xs">
        <div className="rounded-lg border border-border bg-muted/10 px-3 py-2.5">
          <div className="text-muted-foreground">Kalshi-verified inserts</div>
          <div className="font-mono text-base font-semibold mt-0.5">{data.audit.insertedCount}</div>
          <div className="text-[10px] text-muted-foreground mt-1">Missing historical outcomes written only after a finalized YES/NO response.</div>
        </div>
        <div className="rounded-lg border border-border bg-muted/10 px-3 py-2.5">
          <div className="text-muted-foreground">Existing results preserved</div>
          <div className="font-mono text-base font-semibold mt-0.5">{data.audit.unchangedCount}</div>
          <div className="text-[10px] text-muted-foreground mt-1">Historical backfill never overwrote a durable result already present.</div>
        </div>
        <div className="rounded-lg border border-border bg-muted/10 px-3 py-2.5">
          <div className="text-muted-foreground">Audit outcome</div>
          <div className={cn('font-mono text-base font-semibold mt-0.5', data.audit.unresolvedCount || data.audit.errorCount ? 'text-destructive' : 'text-chart-3')}>
            {data.audit.unresolvedCount === 0 && data.audit.errorCount === 0 ? 'No gaps or errors' : `${data.audit.unresolvedCount} gaps · ${data.audit.errorCount} errors`}
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            Audited {Number.isNaN(auditDate.getTime()) ? 'recently' : auditDate.toLocaleDateString()} · {data.audit.candidateCount} former gaps reviewed.
          </div>
        </div>
      </div>

      <div className="px-4 py-2.5 bg-yellow-500/5 border-t border-yellow-500/15 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Research status only.</span> This confirms outcome-label completeness for replay <span className="font-mono">{data.replayId}</span>; it does not approve or apply proposed trading conditions.
      </div>
    </section>
  );
}

// ─── Decision-quality evidence panel ─────────────────────────────────────────

interface DecisionEvidenceCohort {
  label: string;
  settled: number;
  pendingOrUnknown: number;
  wins: number;
  losses: number;
  winRate: number | null;
  winRateCi95: { low: number; high: number } | null;
  netPnlDollars: number | null;
  roi: number | null;
  submittedSettled: number;
  skippedSettled: number;
  sampleStatus: 'no_data' | 'observation' | 'preliminary' | 'evidence_ready';
  caveat: string;
}
interface DecisionEvidenceReport {
  period: string;
  summary: DecisionEvidenceCohort;
  byPriceBand: DecisionEvidenceCohort[];
  bySide: DecisionEvidenceCohort[];
  byAsset: DecisionEvidenceCohort[];
  byEntryTiming: DecisionEvidenceCohort[];
  bySkipReason: DecisionEvidenceCohort[];
  hypotheses: Array<{
    label: string; status: 'observation' | 'preliminary' | 'evidence_ready';
    settled: number; pendingOrUnknown: number; currentNetPnlDollars: number;
    excludedNetPnlDollars: number; retainedNetPnlDollars: number; volumeChange: number; rationale: string;
  }>;
  caveat: string;
  dataSources: { localDecisionRecords: number; durableDecisionRecords: number; orderRecords: number };
}

function statusLabel(status: DecisionEvidenceCohort['sampleStatus'] | 'observation' | 'preliminary' | 'evidence_ready') {
  return status === 'evidence_ready' ? 'Evidence-ready' : status === 'preliminary' ? 'Preliminary' : status === 'observation' ? 'Observation' : 'No settled data';
}
function statusClass(status: DecisionEvidenceCohort['sampleStatus'] | 'observation' | 'preliminary' | 'evidence_ready') {
  return status === 'evidence_ready' ? 'text-chart-3 bg-chart-3/10 border-chart-3/25' : status === 'preliminary' ? 'text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/25' : 'text-muted-foreground bg-muted border-border';
}
function fmtEvidencePnl(value: number | null) {
  return value === null ? '—' : formatSignedUsd(value);
}

const DECISION_EVIDENCE_REFRESH_MS = 60_000;

const EVIDENCE_PERIODS = ['today', '7d', 'all-time'] as const;
type EvidencePeriod = typeof EVIDENCE_PERIODS[number];

function parseEvidencePeriod(raw: string | null): EvidencePeriod {
  if (raw === 'today' || raw === '7d' || raw === 'all-time') return raw;
  return 'all-time';
}

function TradeDecisionEvidencePanel() {
  const search = useSearch();
  const period = parseEvidencePeriod(new URLSearchParams(search).get('evidencePeriod'));

  const setPeriod = (next: EvidencePeriod) => {
    const params = new URLSearchParams(window.location.search);
    params.set('evidencePeriod', next);
    history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  };

  const [data, setData] = useState<DecisionEvidenceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const response = await fetch(`/api/trade/analytics/reports/decision-evidence?period=${period}`, { cache: 'no-store' });
        if (response.ok && alive) {
          setData(await response.json() as DecisionEvidenceReport);
          setLastUpdated(new Date());
        }
      } catch { /* evidence view is read-only and non-critical */ }
      if (alive) setLoading(false);
    };
    void load(true);
    const intervalId = setInterval(() => { void load(false); }, DECISION_EVIDENCE_REFRESH_MS);
    return () => { alive = false; clearInterval(intervalId); };
  }, [period]);
  if (loading && !data) return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Loading decision evidence…</div>;
  if (!data) return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Decision evidence is unavailable.</div>;
  const sections: Array<[string, DecisionEvidenceCohort[]]> = [
    ['Entry price', data.byPriceBand], ['Side', data.bySide], ['Asset', data.byAsset],
    ['Entry timing', data.byEntryTiming], ['Skip reason', data.bySkipReason],
  ];
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap gap-3 items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Decision Evidence</div>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">{data.caveat}</p>
          {lastUpdated && (
            <p className="text-[10px] text-muted-foreground/60 mt-1 flex items-center gap-1">
              <Clock className="h-3 w-3 inline-block" />
              Updated {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · auto-refreshes every 60 s
            </p>
          )}
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden text-xs">
          {(['today', '7d', 'all-time'] as const).map((value) => (
            <button key={value} onClick={() => setPeriod(value)} className={cn('px-2.5 py-1.5 capitalize transition-colors', period === value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground')}>
              {value === 'all-time' ? 'All time' : value}
            </button>
          ))}
        </div>
      </div>
      <div className="grid sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border border-b border-border">
        {[
          ['Settled outcomes', data.summary.settled],
          ['Pending / unknown', data.summary.pendingOrUnknown],
          ['Actual net P&L', fmtEvidencePnl(data.summary.netPnlDollars)],
          ['Actual ROI', data.summary.roi === null ? '—' : `${(data.summary.roi * 100).toFixed(1)}%`],
        ].map(([label, value]) => <div key={String(label)} className="px-4 py-3"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="font-mono font-semibold mt-0.5">{value}</div></div>)}
      </div>
      <div className="px-4 py-3 bg-yellow-500/5 border-b border-yellow-500/15 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">No strategy settings are changed here.</span> “Evidence-ready” requires at least 100 settled observations in the cohort and still requires an owner-approved review.
      </div>
      <div className="p-4 grid xl:grid-cols-2 gap-4">
        {sections.map(([title, cohorts]) => (
          <div key={title} className="border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-muted/20 text-xs font-medium text-foreground">{title}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-y border-border text-muted-foreground">
                  <th className="text-left px-3 py-1.5 font-medium">Cohort</th><th className="text-right px-2 py-1.5 font-medium">Settled</th><th className="text-right px-2 py-1.5 font-medium">W/L · CI</th><th className="text-right px-2 py-1.5 font-medium">Net P&L</th><th className="px-3 py-1.5 font-medium">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-border">{cohorts.map((row) => (
                  <tr key={row.label}>
                    <td className="px-3 py-2 text-foreground">{SKIP_REASON_LABELS[row.label] ?? row.label}<span className="text-muted-foreground"> · {row.pendingOrUnknown}?</span></td>
                    <td className="px-2 py-2 text-right font-mono">{row.settled}</td>
                    <td className="px-2 py-2 text-right font-mono">{row.winRate === null ? '—' : `${row.wins}/${row.losses} · ${(row.winRate * 100).toFixed(0)}%${row.winRateCi95 ? ` (${(row.winRateCi95.low * 100).toFixed(0)}–${(row.winRateCi95.high * 100).toFixed(0)})` : ''}`}</td>
                    <td className={cn('px-2 py-2 text-right font-mono', (row.netPnlDollars ?? 0) < 0 ? 'text-destructive' : 'text-chart-3')}>{fmtEvidencePnl(row.netPnlDollars)}</td>
                    <td className="px-3 py-2 text-center"><span className={cn('inline-block px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap', statusClass(row.sampleStatus))}>{statusLabel(row.sampleStatus)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="px-4 py-2.5 text-xs font-medium text-foreground">Ranked hypothesis watchlist</div>
        <div className="divide-y divide-border">{data.hypotheses.slice(0, 5).map((item) => (
          <div key={item.label} className="px-4 py-2.5 flex flex-wrap gap-x-3 gap-y-1 items-center text-xs">
            <span className="font-medium text-foreground">{item.label}</span>
            <span className={cn('px-1.5 py-0.5 rounded border text-[10px]', statusClass(item.status))}>{statusLabel(item.status)}</span>
            <span className="font-mono text-muted-foreground">{item.settled} settled · {item.volumeChange} trades if excluded · excluded P&L {formatSignedUsd(item.excludedNetPnlDollars)}</span>
            <span className="basis-full text-muted-foreground">{item.rationale}</span>
          </div>
        ))}</div>
        <div className="px-4 py-2 text-[10px] text-muted-foreground bg-muted/10">Sources: {data.dataSources.orderRecords} order records · {data.dataSources.localDecisionRecords} local decisions · {data.dataSources.durableDecisionRecords} durable decisions.</div>
      </div>
    </div>
  );
}

// ─── H-002 research sufficiency ───────────────────────────────────────────────
interface H002EvidenceReadinessReport {
  status: 'no_data' | 'observation' | 'preliminary' | 'evidence_ready';
  counts: {
    decisionRecords: number; submittedDecisions: number; orderRecords: number;
    matchedSubmittedOrders: number; unmatchedSubmittedDecisions: number;
    filledOrders: number; reconciledFilledOrders: number; pendingFilledOrders: number;
    settledDecisionOutcomes: number; pendingDecisionOutcomes: number;
  };
  telemetry: { completeDecisions: number; missingQuotedBbo: number; missingBboAge: number; missingExecutableAsk: number; missingVerifiedLimit: number; missingDepth: number; missingL2Latency: number };
  byDecision: Array<{ decision: string; records: number; settledOutcomes: number }>;
  blockingGaps: string[];
  dataSources: { localDecisionRecords: number; durableDecisionRecords: number; orderRecords: number };
  caveat: string;
  readonly: true;
}
function H002EvidenceReadinessPanel() {
  const search = useSearch();
  const period = parseEvidencePeriod(new URLSearchParams(search).get('evidencePeriod'));
  const [data, setData] = useState<H002EvidenceReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const response = await fetch(`/api/trade/analytics/reports/h-002-evidence?period=${period}`, { cache: 'no-store' });
        if (response.ok && alive) setData(await response.json() as H002EvidenceReadinessReport);
      } catch { /* passive research card must never interrupt the dashboard */ }
      if (alive) setLoading(false);
    };
    void load(true);
    const intervalId = setInterval(() => { void load(false); }, DECISION_EVIDENCE_REFRESH_MS);
    return () => { alive = false; clearInterval(intervalId); };
  }, [period]);
  if (loading && !data) return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Checking research readiness…</div>;
  if (!data) return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Research readiness is unavailable.</div>;
  const c = data.counts;
  return (
    <section className="border border-border rounded-xl overflow-hidden" aria-labelledby="h002-title" data-testid="h002-evidence-readiness-panel">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap gap-3 items-start justify-between">
        <div>
          <div id="h002-title" className="text-sm font-semibold text-foreground">Research Evidence Readiness</div>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-3xl">{data.caveat}</p>
        </div>
        <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-xs font-medium', statusClass(data.status))}>{statusLabel(data.status)}</span>
      </div>
      <div className="grid sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border border-b border-border">
        {[
          ['Decision observations', c.decisionRecords],
          ['Decision → order joined', `${c.matchedSubmittedOrders} / ${c.submittedDecisions}`],
          ['Reconciled fills', `${c.reconciledFilledOrders} / ${c.filledOrders}`],
          ['Settled decision outcomes', `${c.settledDecisionOutcomes} / ${c.decisionRecords}`],
        ].map(([label, value]) => <div key={String(label)} className="px-4 py-3"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="font-mono font-semibold mt-0.5">{value}</div></div>)}
      </div>
      <div className="p-4 grid lg:grid-cols-2 gap-4 text-xs">
        <div>
          <div className="font-medium text-foreground">Blocking evidence gaps</div>
          {data.blockingGaps.length === 0
            ? <p className="mt-2 text-chart-3">No capture, join, settlement, or telemetry gaps are currently blocking this scope.</p>
            : <ul className="mt-2 space-y-1.5 text-muted-foreground">{data.blockingGaps.map((gap) => <li key={gap} className="flex gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />{gap}</li>)}</ul>}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 content-start">
          <div><div className="text-[10px] uppercase text-muted-foreground">Complete telemetry</div><div className="font-mono">{data.telemetry.completeDecisions} / {c.decisionRecords}</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Pending outcomes</div><div className="font-mono">{c.pendingDecisionOutcomes}</div></div>
          <div className="col-span-2"><div className="text-[10px] uppercase text-muted-foreground">Telemetry missing (BBO / L2 ask / limit / depth / latency)</div><div className="font-mono">{data.telemetry.missingQuotedBbo} / {data.telemetry.missingExecutableAsk} / {data.telemetry.missingVerifiedLimit} / {data.telemetry.missingDepth} / {data.telemetry.missingL2Latency}</div></div>
          <div className="col-span-2 text-[10px] text-muted-foreground">Sources: {data.dataSources.orderRecords} orders · {data.dataSources.localDecisionRecords} local decisions · {data.dataSources.durableDecisionRecords} durable decisions.</div>
        </div>
      </div>
      <div className="px-4 py-2.5 bg-yellow-500/5 border-t border-yellow-500/15 text-xs text-muted-foreground"><span className="font-medium text-foreground">Observation only.</span> This reports capture quality; it cannot modify qualification, sizing, gates, or order submission.</div>
    </section>
  );
}

// ─── Conservative condition recommendations ────────────────────────────────────

interface ConditionRecommendation {
  id: string;
  kind: 'entry_zone_exclusion' | 'entry_timing_exclusion' | 'asset_exclusion' | 'preflight_gate_review';
  status: 'observation' | 'preliminary' | 'actionable';
  currentCondition: string;
  proposedCondition: string;
  reason: string;
  settledSamples: number;
  pendingSamples: number;
  retainedSettledSamples: number;
  volumeChangeTrades: number | null;
  volumeChangePct: number | null;
  estimatedNetPnlImpactDollars: number | null;
  impactBasis: 'realized_fill_pnl' | 'outcome_only_counterfactual';
  currentNetPnlDollars: number | null;
  proposedNetPnlDollars: number | null;
  winRate: number | null;
  roi: number | null;
  winRateCi95: { low: number; high: number } | null;
  uncertainty: string;
  evidenceUrl: string;
}
interface ConditionRecommendationsReport {
  period: string;
  asset: 'BTC' | 'ETH' | 'all';
  recommendations: ConditionRecommendation[];
  excludedCandidates: Array<{ label: string; reason: string }>;
  dataSources: { orderRecords: number; decisionRecords: number };
  caveat: string;
  readonly: true;
}
type RecommendationAsset = 'all' | 'BTC' | 'ETH';
function recommendationStatusClass(status: ConditionRecommendation['status']) {
  return status === 'actionable'
    ? 'text-chart-3 bg-chart-3/10 border-chart-3/25'
    : status === 'preliminary'
      ? 'text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/25'
      : 'text-muted-foreground bg-muted border-border';
}
function recommendationStatusLabel(status: ConditionRecommendation['status']) {
  return status === 'actionable' ? 'Actionable review' : status === 'preliminary' ? 'Preliminary' : 'Observation';
}
function ConditionRecommendationsPanel() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const [period, setPeriod] = useState<EvidencePeriod>(() => parseEvidencePeriod(params.get('recommendationPeriod')));
  const rawAsset = params.get('recommendationAsset');
  const [asset, setAsset] = useState<RecommendationAsset>(() => rawAsset === 'BTC' || rawAsset === 'ETH' ? rawAsset : 'all');
  const [data, setData] = useState<ConditionRecommendationsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const setScope = (nextPeriod: EvidencePeriod, nextAsset: RecommendationAsset) => {
    setPeriod(nextPeriod);
    setAsset(nextAsset);
    const next = new URLSearchParams(window.location.search);
    next.set('recommendationPeriod', nextPeriod);
    next.set('recommendationAsset', nextAsset);
    history.replaceState(null, '', `${window.location.pathname}?${next.toString()}`);
  };
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/trade/analytics/reports/condition-recommendations?period=${period}&asset=${asset}`, { cache: 'no-store' });
        if (response.ok && alive) setData(await response.json() as ConditionRecommendationsReport);
      } catch { /* report is advisory only */ }
      if (alive) setLoading(false);
    };
    void load();
    return () => { alive = false; };
  }, [period, asset]);
  if (loading && !data) return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Loading condition recommendations…</div>;
  if (!data) return <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">Condition recommendations are unavailable.</div>;
  return (
    <div className="border border-border rounded-xl overflow-hidden" data-testid="condition-recommendations-panel">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap gap-3 items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Condition Recommendations</div>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-3xl">{data.caveat}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {(['today', '7d', 'all-time'] as const).map((value) => (
              <button key={value} onClick={() => setScope(value, asset)} className={cn('px-2.5 py-1.5 transition-colors', period === value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground')}>
                {value === 'all-time' ? 'All time' : value}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {(['all', 'BTC', 'ETH'] as const).map((value) => (
              <button key={value} onClick={() => setScope(period, value)} className={cn('px-2.5 py-1.5 transition-colors', asset === value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground')}>
                {value === 'all' ? 'All assets' : value}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="px-4 py-3 bg-yellow-500/5 border-b border-yellow-500/15 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Owner review required.</span> This panel cannot apply, write, enable, or change any live strategy condition, gate, position limit, or budget.
      </div>
      {data.recommendations.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">No loss-making realized cohorts are available to rank in this scope. This is not a recommendation to change the live strategy.</div>
      ) : (
        <div className="divide-y divide-border">
          {data.recommendations.map((item) => (
            <div key={item.id} className="px-4 py-4 grid lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{item.proposedCondition}</span>
                  <span className={cn('px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap', recommendationStatusClass(item.status))}>{recommendationStatusLabel(item.status)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{item.impactBasis === 'realized_fill_pnl' ? 'Realized fills' : 'Outcome-only gate evidence'}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{item.reason}</p>
                <div className="mt-2 text-xs">
                  <span className="text-muted-foreground">Current: </span><span className="font-mono">{item.currentCondition}</span>
                  <span className="text-muted-foreground mx-2">→</span>
                  <span className="font-mono text-foreground">{item.proposedCondition}</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">{item.uncertainty}</p>
                <div className="mt-2 flex gap-3 text-xs">
                  <a className="text-primary hover:underline" href={`?evidencePeriod=${period}`}>Inspect evidence</a>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs content-start">
                <div><div className="text-[10px] uppercase text-muted-foreground">Settled / pending</div><div className="font-mono">{item.settledSamples} / {item.pendingSamples}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">Volume impact</div><div className="font-mono">{item.volumeChangeTrades === null ? 'Not estimated' : `${item.volumeChangeTrades} trades${item.volumeChangePct === null ? '' : ` (${(item.volumeChangePct * 100).toFixed(1)}%)`}`}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">Est. net P&amp;L impact</div><div className={cn('font-mono', (item.estimatedNetPnlImpactDollars ?? 0) > 0 ? 'text-chart-3' : 'text-muted-foreground')}>{item.estimatedNetPnlImpactDollars === null ? 'Not estimated' : formatSignedUsd(item.estimatedNetPnlImpactDollars)}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">Win rate / ROI</div><div className="font-mono">{item.winRate === null ? '—' : `${(item.winRate * 100).toFixed(1)}%${item.roi === null ? '' : ` / ${(item.roi * 100).toFixed(1)}%`}`}</div></div>
                <div className="col-span-2"><div className="text-[10px] uppercase text-muted-foreground">95% win-rate range</div><div className="font-mono">{item.winRateCi95 ? `${(item.winRateCi95.low * 100).toFixed(1)}%–${(item.winRateCi95.high * 100).toFixed(1)}%` : '—'} · {item.retainedSettledSamples} comparable retained settled fills</div></div>
              </div>
            </div>
          ))}
        </div>
      )}
      {data.excludedCandidates.length > 0 && <div className="px-4 py-2 text-[10px] text-muted-foreground bg-muted/10">Not ranked: {data.excludedCandidates.map((candidate) => candidate.label).join(' · ')}.</div>}
      <div className="px-4 py-2 text-[10px] text-muted-foreground bg-muted/10">Sources: {data.dataSources.orderRecords} order records · {data.dataSources.decisionRecords} decision records.</div>
    </div>
  );
}

// ─── Preflight Calibration Panel ─────────────────────────────────────────────

interface CalibrationBucket {
  skipReason: string;
  total: number;
  saved: number;
  cost: number;
  unknown: number;
  saveRate: number | null;
  avgBboToL2GapCents: number | null;
  avgExecAskCents: number | null;
}

interface CalibrationSeriesBucket {
  series: string;
  total: number;
  saved: number;
  cost: number;
  unknown: number;
  saveRate: number | null;
}

interface PreflightCalibrationReport {
  generatedAt: string;
  daysAnalyzed: number;
  totalDecisions: number;
  totalSubmitted: number;
  totalSkipped: number;
  settledSkips: number;
  overallSaveRate: number | null;
  byReason: CalibrationBucket[];
  bySeries: CalibrationSeriesBucket[];
  constants: {
    MAX_BBO_L2_GAP_CENTS: number;
    MAX_BBO_L2_NEGATIVE_GAP_CENTS: number;
    ALERT_MIN: number;
    ALERT_MAX: number;
  };
  tuningNotes: string[];
  sampleWarning: string | null;
}

function usePreflightCalibration(days = 7): { data: PreflightCalibrationReport | null; loading: boolean } {
  const [data, setData] = useState<PreflightCalibrationReport | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const fetch_ = async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/trade/analytics/reports/preflight-calibration?days=${days}`, { cache: 'no-store' });
        if (r.ok && alive) setData(await r.json() as PreflightCalibrationReport);
      } catch { /* non-critical */ }
      if (alive) setLoading(false);
    };
    void fetch_();
    const id = setInterval(fetch_, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [days]);
  return { data, loading };
}

const SKIP_REASON_LABELS: Record<string, string> = {
  skip_stale_bbo_gap:            'Stale BBO gap',
  skip_zero_depth:               'Zero depth',
  skip_zero_contracts:           'Zero contracts',
  skip_ask_above_strategy_limit: 'Ask > limit',
  skip_price_band:               'Price band',
  skip_l2_unavailable:           'L2 unavailable',
};

function saveRateColor(rate: number | null): string {
  if (rate === null) return 'text-muted-foreground';
  if (rate >= 0.55) return 'text-chart-3';
  if (rate >= 0.40) return 'text-chart-2';
  return 'text-destructive';
}

function PreflightCalibrationPanel() {
  const { data, loading } = usePreflightCalibration(7);

  if (loading && !data) {
    return (
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 bg-muted/30 border-b border-border">
          <div className="text-sm font-semibold text-foreground">L2 Filter Calibration</div>
        </div>
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 bg-muted/30 border-b border-border">
          <div className="text-sm font-semibold text-foreground">L2 Filter Calibration</div>
        </div>
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">No data available.</div>
      </div>
    );
  }

  const saveRatePct = data.overallSaveRate !== null
    ? `${(data.overallSaveRate * 100).toFixed(0)}%`
    : '—';
  const overallColor = saveRateColor(data.overallSaveRate);

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">L2 Filter Calibration</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Last {data.daysAnalyzed} day{data.daysAnalyzed !== 1 ? 's' : ''} · {data.totalSkipped} skips,{' '}
            {data.settledSkips} settled
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Filter save rate</div>
          <div className={cn('font-mono font-bold text-lg leading-tight', overallColor)}>
            {saveRatePct}
          </div>
          {data.settledSkips > 0 && (
            <div className="text-[10px] text-muted-foreground tabular-nums">
              {data.byReason.reduce((s, b) => s + b.saved, 0)} saved ·{' '}
              {data.byReason.reduce((s, b) => s + b.cost, 0)} cost
            </div>
          )}
        </div>
      </div>

      {/* Sample warning */}
      {data.sampleWarning && (
        <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-xs text-yellow-600 dark:text-yellow-400">
          {data.sampleWarning}
        </div>
      )}

      {/* Constants strip */}
      <div className="flex flex-wrap gap-4 px-4 py-2.5 bg-muted/10 border-b border-border text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">BBO↔L2 gap limit</span>
          <span className="font-mono font-semibold text-foreground">
            ±{data.constants.MAX_BBO_L2_GAP_CENTS}¢ / −{data.constants.MAX_BBO_L2_NEGATIVE_GAP_CENTS}¢
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Entry zone</span>
          <span className="font-mono font-semibold text-foreground">
            {data.constants.ALERT_MIN}–{data.constants.ALERT_MAX}¢
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Submitted</span>
          <span className="font-mono font-semibold text-foreground">{data.totalSubmitted}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Skipped</span>
          <span className="font-mono font-semibold text-foreground">{data.totalSkipped}</span>
        </div>
      </div>

      {/* Per-reason table */}
      {data.byReason.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Skip reason</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Total</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Saved</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Cost</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Unknown</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Save rate</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Avg gap</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.byReason.map((b) => (
                <tr key={b.skipReason} className="hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2 text-foreground font-medium">
                    {SKIP_REASON_LABELS[b.skipReason] ?? b.skipReason}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-foreground">{b.total}</td>
                  <td className="px-3 py-2 text-center tabular-nums text-chart-3 font-medium">
                    {b.saved > 0 ? b.saved : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-destructive font-medium">
                    {b.cost > 0 ? b.cost : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-muted-foreground">{b.unknown || '—'}</td>
                  <td className={cn('px-3 py-2 text-center tabular-nums font-semibold font-mono', saveRateColor(b.saveRate))}>
                    {b.saveRate !== null ? `${(b.saveRate * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-muted-foreground hidden sm:table-cell">
                    {b.avgBboToL2GapCents !== null ? `${b.avgBboToL2GapCents.toFixed(1)}¢` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-series row */}
      {data.bySeries.length > 1 && (
        <div className="flex gap-px bg-border border-t border-border">
          {data.bySeries.map((s) => (
            <div key={s.series} className="flex-1 bg-card px-3 py-2.5 text-center">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">
                {s.series.replace('KX', '').replace('15M', '')}
              </div>
              <div className={cn('font-mono font-semibold text-sm', saveRateColor(s.saveRate))}>
                {s.saveRate !== null ? `${(s.saveRate * 100).toFixed(0)}%` : '—'}
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums">
                {s.saved}↑ {s.cost}↓ {s.unknown}?
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tuning notes */}
      {data.tuningNotes.length > 0 && (
        <div className="border-t border-border px-4 py-3 space-y-1">
          {data.tuningNotes.map((note, i) => (
            <p key={i} className="text-xs text-muted-foreground leading-relaxed">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Zero-fill analysis panel helpers ────────────────────────────────────────

interface TickerRow {
  ticker: string;
  count: number;
  no_depth: number;
  price_too_low: number;
  partial_depth: number;
  unknown: number;
  gtcHigh: number;
  gtcMedium: number;
  gtcLow: number;
  gtcZero: number;
  gtcUnknown: number;
}

function ZeroFillAnalysisPanel() {
  const { data, loading } = useRestingOrderSim(7);
  const [expanded, setExpanded] = useState(false);

  if (loading && !data) {
    return (
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 bg-muted/30 border-b border-border">
          <div className="text-sm font-semibold text-foreground">Zero-fill Analysis</div>
        </div>
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!data || data.zeroFills === 0) {
    return (
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">Zero-fill Analysis</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Last {data?.daysAnalyzed ?? 7} days · miss-hint breakdown
            </div>
          </div>
        </div>
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          {data ? 'No zero-fills in the last 7 days.' : 'No data available.'}
        </div>
      </div>
    );
  }

  // Aggregate miss classification counts
  const missCount: Record<OrderSimResult['missClassification'], number> = {
    no_depth: 0, price_too_low: 0, partial_depth: 0, unknown: 0,
  };
  const likelihoodCount: Record<OrderSimResult['restingFillLikelihood'], number> = {
    high: 0, medium: 0, low: 0, zero: 0, unknown: 0,
  };
  const tickerMap = new Map<string, TickerRow>();

  for (const r of data.results) {
    missCount[r.missClassification]++;
    likelihoodCount[r.restingFillLikelihood]++;

    if (!tickerMap.has(r.ticker)) {
      tickerMap.set(r.ticker, {
        ticker: r.ticker, count: 0,
        no_depth: 0, price_too_low: 0, partial_depth: 0, unknown: 0,
        gtcHigh: 0, gtcMedium: 0, gtcLow: 0, gtcZero: 0, gtcUnknown: 0,
      });
    }
    const row = tickerMap.get(r.ticker)!;
    row.count++;
    row[r.missClassification]++;
    if (r.restingFillLikelihood === 'high')    row.gtcHigh++;
    else if (r.restingFillLikelihood === 'medium') row.gtcMedium++;
    else if (r.restingFillLikelihood === 'low')    row.gtcLow++;
    else if (r.restingFillLikelihood === 'zero')   row.gtcZero++;
    else                                           row.gtcUnknown++;
  }

  const tickerRows = [...tickerMap.values()].sort((a, b) => b.count - a.count);
  const l2CoverageCount = data.results.filter((r) => r.hasL2Snapshot).length;
  const gtcFillableCount = likelihoodCount.high + likelihoodCount.medium;
  const gtcFillPct = data.zeroFills > 0 ? Math.round((gtcFillableCount / data.zeroFills) * 100) : 0;

  const displayRows = expanded ? tickerRows : tickerRows.slice(0, 5);

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Zero-fill Analysis</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Last {data.daysAnalyzed} days · {data.zeroFills} zero-fills from {data.totalOrders} submissions
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
        {(Object.keys(missCount) as OrderSimResult['missClassification'][]).map((k) => (
          <div key={k} className="bg-card px-3 py-2.5 text-center">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">
              {MISS_LABELS[k]}
            </div>
            <div className={cn('font-mono font-semibold text-sm', MISS_COLORS[k])}>
              {missCount[k]}
            </div>
            {data.zeroFills > 0 && (
              <div className="text-[10px] text-muted-foreground tabular-nums">
                {Math.round((missCount[k] / data.zeroFills) * 100)}%
              </div>
            )}
          </div>
        ))}
      </div>

      {/* GTC / L2 summary row */}
      <div className="flex flex-wrap gap-4 px-4 py-2.5 bg-muted/10 border-b border-border text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Est. GTC fillable</span>
          <span className={cn('font-mono font-semibold', gtcFillPct >= 50 ? 'text-chart-3' : gtcFillPct >= 20 ? 'text-chart-2' : 'text-muted-foreground')}>
            {gtcFillableCount}/{data.zeroFills} ({gtcFillPct}%)
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">L2 coverage</span>
          <span className="font-mono font-semibold text-foreground">
            {l2CoverageCount}/{data.zeroFills}
          </span>
        </div>
        {(['high', 'medium', 'low', 'zero'] as const).map((lk) => likelihoodCount[lk] > 0 && (
          <div key={lk} className="flex items-center gap-1">
            <span className={cn('font-mono font-semibold', LIKELIHOOD_COLORS[lk])}>{likelihoodCount[lk]}</span>
            <span className="text-muted-foreground">{lk}</span>
          </div>
        ))}
      </div>

      {/* Per-ticker table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/20">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Ticker</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Misses</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">No depth</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Price low</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Thin</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Unknown</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">GTC est.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {displayRows.map((row) => {
              const gtcLabel =
                row.gtcHigh > 0   ? `${row.gtcHigh}h` :
                row.gtcMedium > 0 ? `${row.gtcMedium}m` :
                row.gtcLow > 0    ? `${row.gtcLow}l` : '—';
              const gtcColor =
                row.gtcHigh > 0   ? 'text-chart-3' :
                row.gtcMedium > 0 ? 'text-chart-2' :
                row.gtcLow > 0    ? 'text-orange-500' : 'text-muted-foreground';
              return (
                <tr key={row.ticker} className="hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2 font-mono text-foreground truncate max-w-[160px]" title={row.ticker}>
                    {row.ticker}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums font-medium text-foreground">{row.count}</td>
                  <td className="px-3 py-2 text-center tabular-nums">
                    <span className={row.no_depth > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                      {row.no_depth || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums hidden sm:table-cell">
                    <span className={row.price_too_low > 0 ? 'text-orange-500' : 'text-muted-foreground'}>
                      {row.price_too_low || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums hidden sm:table-cell">
                    <span className={row.partial_depth > 0 ? 'text-yellow-500' : 'text-muted-foreground'}>
                      {row.partial_depth || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-muted-foreground hidden sm:table-cell">
                    {row.unknown || '—'}
                  </td>
                  <td className={cn('px-3 py-2 text-center tabular-nums font-medium', gtcColor)}>
                    {gtcLabel}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Expand/collapse */}
      {tickerRows.length > 5 && (
        <div className="border-t border-border px-4 py-2 text-center">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? `Show less` : `Show all ${tickerRows.length} tickers`}
          </button>
        </div>
      )}
    </div>
  );
}

interface RestingOrderSimResponse {
  generatedAt:  string;
  daysAnalyzed: number;
  totalOrders:  number;
  zeroFills:    number;
  results:      OrderSimResult[];
  caveats:      string[];
}

function useRestingOrderSim(days = 7): { data: RestingOrderSimResponse | null; loading: boolean } {
  const [data, setData] = useState<RestingOrderSimResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const fetch_ = async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/trade/resting-order-sim?days=${days}`, { cache: 'no-store' });
        if (r.ok && alive) setData(await r.json() as RestingOrderSimResponse);
      } catch { /* non-critical */ }
      if (alive) setLoading(false);
    };
    void fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [days]);
  return { data, loading };
}

const LIKELIHOOD_COLORS: Record<OrderSimResult['restingFillLikelihood'], string> = {
  high:    'text-chart-3',
  medium:  'text-chart-2',
  low:     'text-orange-500',
  zero:    'text-muted-foreground',
  unknown: 'text-muted-foreground',
};

const MISS_LABELS: Record<OrderSimResult['missClassification'], string> = {
  no_depth:     'No depth',
  price_too_low: 'Price too low',
  partial_depth: 'Thin depth',
  unknown:       'Unknown',
};

const MISS_COLORS: Record<OrderSimResult['missClassification'], string> = {
  no_depth:      'text-destructive',
  price_too_low: 'text-orange-500',
  partial_depth: 'text-yellow-500',
  unknown:       'text-muted-foreground',
};

interface EntryGapBucket {
  label:            string;
  fills:            number;
  reconciled:       number;
  wins:             number;
  losses:           number;
  winRate:          number | null;
  avgGapCents:      number | null;
  avgNetPnlDollars: number | null;
  sampleWarning:    string | null;
}

interface ReverseSimResult {
  count:                    number;
  avgYesEntryPriceCents:    number | null;
  avgNoEntryPriceCents:     number | null;
  actualWins:               number;
  actualLosses:             number;
  actualWinRate:            number | null;
  actualTotalPnlDollars:    number | null;
  actualAvgPnlDollars:      number | null;
  simWins:                  number;
  simLosses:                number;
  simWinRate:               number | null;
  simTotalPnlDollars:       number | null;
  simAvgPnlDollars:         number | null;
  deltaAvgPnlDollars:       number | null;
  sampleWarning:            string | null;
}

interface EntryGapReport {
  period:               string;
  buckets:              EntryGapBucket[];
  trades:               EntryGapTrade[];
  excludedMissingPrice: number;
  fallingKnifeGapCents: number;
  reverseSimMinGapCents: number;
  pending:              { fillsTotal: number; fillsPending: number };
  reverseSim:           ReverseSimResult;
  reverseSimAll:        { '5': ReverseSimResult; '7': ReverseSimResult; '10': ReverseSimResult };
}

function FallingKnifePanel() {
  const [period, setPeriod] = useState<'today' | '7d' | 'all-time'>('all-time');
  const [showTrades, setShowTrades] = useState(false);
  const { data, loading } = useEntryGapReport(period);

  const header = (
    <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between gap-2">
      <div>
        <div className="text-sm font-semibold text-foreground">Falling-Knife Detector</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Trigger→fill price gap · a large gap means the price was collapsing at entry
        </div>
      </div>
      <div className="flex gap-1">
        {(['today', '7d', 'all-time'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors',
              period === p
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );

  if (loading && !data) {
    return (
      <div className="border border-border rounded-xl overflow-hidden">
        {header}
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!data || data.trades.length === 0) {
    return (
      <div className="border border-border rounded-xl overflow-hidden">
        {header}
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No filled trades with a recorded trigger→fill gap for this period yet.
        </div>
      </div>
    );
  }

  const knives = data.trades.filter((t) => t.fallingKnife);

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {header}

      {knives.length > 0 && (
        <div className="px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-xs text-destructive">
          {knives.length} trade{knives.length !== 1 ? 's' : ''} entered with a {data.fallingKnifeGapCents}¢+ gap — price was collapsing through the entry zone at fill time.
        </div>
      )}

      {/* Win rate by gap size */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/20">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Trigger→fill gap</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Fills</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">W / L</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Win %</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Avg gap</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Avg net P&amp;L</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.buckets.map((b) => {
              const winPct = b.winRate != null ? (b.winRate * 100).toFixed(1) : null;
              const winColor = b.winRate == null ? '' :
                b.winRate >= 0.5 ? 'text-chart-3' :
                b.winRate >= 0.4 ? 'text-amber-500' : 'text-destructive';
              return (
                <tr key={b.label} className={cn('hover:bg-muted/20 transition-colors', b.fills === 0 ? 'opacity-40' : '')}>
                  <td className="px-3 py-2 font-mono text-foreground">{b.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">
                    {b.fills > 0 ? b.fills : '—'}
                    {b.sampleWarning === 'very_small' && b.fills > 0 && (
                      <span className="ml-1 text-amber-500/70 text-[10px]">*</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {b.reconciled > 0 ? `${b.wins}/${b.losses}` : '—'}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums font-medium', winColor)}>
                    {winPct != null ? `${winPct}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground font-mono hidden sm:table-cell">
                    {b.avgGapCents != null ? `${b.avgGapCents.toFixed(1)}¢` : '—'}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums font-mono hidden md:table-cell',
                    b.avgNetPnlDollars == null ? 'text-muted-foreground' :
                    b.avgNetPnlDollars > 0 ? 'text-chart-3' :
                    b.avgNetPnlDollars < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {b.avgNetPnlDollars != null ? formatSignedUsd(b.avgNetPnlDollars) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.buckets.some((b) => b.sampleWarning === 'very_small' && b.fills > 0) && (
        <div className="px-4 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
          * fewer than 30 settled fills — results are preliminary
        </div>
      )}

      <ReverseSimSection reverseSimAll={data.reverseSimAll} />

      {/* Per-trade gap list */}
      <button
        onClick={() => setShowTrades((v) => !v)}
        className="w-full px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors border-t border-border flex items-center gap-1.5"
      >
        <span className={cn('transition-transform inline-block', showTrades ? 'rotate-90' : '')}>▸</span>
        Per-trade gaps ({data.trades.length} recent fill{data.trades.length !== 1 ? 's' : ''})
      </button>

      {showTrades && (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Time (UTC)</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Ticker</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Side</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Trigger</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Fill</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Gap</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground">Result</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Net P&amp;L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.trades.map((t) => (
                <tr key={t.id} className={cn('hover:bg-muted/20 transition-colors', t.fallingKnife ? 'bg-destructive/5' : '')}>
                  <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                    {new Date(t.timestampMs).toISOString().slice(5, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2 font-mono text-foreground whitespace-nowrap">{t.ticker}</td>
                  <td className="px-3 py-2 uppercase text-muted-foreground">{t.side}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-foreground">{t.triggerPriceCents}¢</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-foreground">
                    {t.fillPriceCents}¢
                    {t.estimatedFillPrice && (
                      <span
                        className="ml-1.5 px-1 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-sans font-medium whitespace-nowrap"
                        title="Estimated — fill data unavailable (reconciliation permanently failed)"
                      >EST</span>
                    )}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums font-mono font-medium', gapColor(t.gapCents))}>
                    {t.gapCents > 0 ? `−${t.gapCents}¢` : t.gapCents < 0 ? `+${-t.gapCents}¢` : '0¢'}
                    {t.fallingKnife && (
                      <span className="ml-1.5 px-1 py-0.5 rounded bg-destructive/15 text-destructive text-[10px] font-sans font-medium whitespace-nowrap">KNIFE</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {t.win === true ? <span className="text-chart-3 font-medium">WIN</span> :
                     t.win === false ? <span className="text-destructive font-medium">LOSS</span> :
                     <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums font-mono hidden md:table-cell',
                    t.netPnlDollars == null ? 'text-muted-foreground' :
                    t.netPnlDollars > 0 ? 'text-chart-3' :
                    t.netPnlDollars < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {t.netPnlDollars != null ? formatSignedUsd(t.netPnlDollars) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.excludedMissingPrice > 0 && (
        <div className="px-4 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
          {data.excludedMissingPrice} fill{data.excludedMissingPrice !== 1 ? 's' : ''} excluded — trigger or fill price not recorded
        </div>
      )}
    </div>
  );
}

function gapColor(gap: number): string {
  if (gap >= 7) return 'text-destructive';
  if (gap >= 3) return 'text-amber-500';
  return 'text-muted-foreground';
}

function ReverseSimSection({ reverseSimAll }: { reverseSimAll: EntryGapReport['reverseSimAll'] }) {
  const thresholds = [
    { key: '5'  as const, label: '≥ 5¢' },
    { key: '7'  as const, label: '≥ 7¢' },
    { key: '10' as const, label: '≥ 10¢' },
  ];

  const allEmpty = thresholds.every((t) => reverseSimAll[t.key].count === 0);

  // Find the threshold with the highest positive deltaAvgPnlDollars (> 0).
  // If all deltas are ≤ 0 or null, bestKey stays null and no highlight is shown.
  const bestKey = (() => {
    let best: typeof thresholds[number]['key'] | null = null;
    let bestVal = 0; // must beat 0 to qualify
    for (const t of thresholds) {
      const delta = reverseSimAll[t.key].deltaAvgPnlDollars;
      if (delta != null && delta > bestVal) {
        bestVal = delta;
        best = t.key;
      }
    }
    return best;
  })();

  // Returns highlight classes for a cell in a given threshold column.
  const colHighlight = (key: typeof thresholds[number]['key']) =>
    key === bestKey ? 'bg-chart-3/10' : '';

  return (
    <div className="border-t border-border">
      <div className="px-4 py-3 bg-muted/20">
        <div className="text-xs font-semibold text-foreground">Reverse simulation — threshold comparison</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          What if we had bought NO instead of YES on every falling-knife window? Results across three gap thresholds.
        </div>
      </div>

      {allEmpty ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          No outcome-reconciled falling-knife YES entries yet — simulation will appear once markets settle.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/10">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Metric</th>
                {thresholds.map((t) => (
                  <th key={t.key} className={cn(
                    'text-right px-3 py-2 font-medium',
                    t.key === bestKey
                      ? 'text-chart-3 bg-chart-3/10'
                      : 'text-muted-foreground',
                  )}>
                    {t.label}
                    {t.key === bestKey && (
                      <span className="ml-1 text-[9px] font-semibold tracking-wide uppercase opacity-70">best</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {/* Count */}
              <tr className="hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 text-muted-foreground">Count</td>
                {thresholds.map((t) => {
                  const sim = reverseSimAll[t.key];
                  return (
                    <td key={t.key} className={cn('px-3 py-2 text-right tabular-nums text-foreground', colHighlight(t.key))}>
                      {sim.count > 0 ? (
                        <>
                          {sim.count}
                          {sim.sampleWarning === 'very_small' && (
                            <span className="ml-1 text-amber-500/70 text-[10px]">*</span>
                          )}
                        </>
                      ) : '—'}
                    </td>
                  );
                })}
              </tr>
              {/* YES win rate */}
              <tr className="hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 text-muted-foreground">YES win rate</td>
                {thresholds.map((t) => {
                  const sim = reverseSimAll[t.key];
                  const pct = sim.actualWinRate != null ? (sim.actualWinRate * 100).toFixed(1) + '%' : '—';
                  const color = sim.actualWinRate == null ? 'text-muted-foreground' :
                    sim.actualWinRate >= 0.5 ? 'text-chart-3' :
                    sim.actualWinRate >= 0.4 ? 'text-amber-500' : 'text-destructive';
                  return (
                    <td key={t.key} className={cn('px-3 py-2 text-right tabular-nums font-medium', color, colHighlight(t.key))}>
                      {pct}
                    </td>
                  );
                })}
              </tr>
              {/* Sim NO win rate */}
              <tr className="hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 text-muted-foreground">Sim NO win rate</td>
                {thresholds.map((t) => {
                  const sim = reverseSimAll[t.key];
                  const pct = sim.simWinRate != null ? (sim.simWinRate * 100).toFixed(1) + '%' : '—';
                  const color = sim.simWinRate == null ? 'text-muted-foreground' :
                    sim.simWinRate >= 0.5 ? 'text-chart-3' :
                    sim.simWinRate >= 0.4 ? 'text-amber-500' : 'text-destructive';
                  return (
                    <td key={t.key} className={cn('px-3 py-2 text-right tabular-nums font-medium', color, colHighlight(t.key))}>
                      {pct}
                    </td>
                  );
                })}
              </tr>
              {/* Avg P&L delta */}
              <tr className="hover:bg-muted/20 transition-colors font-semibold">
                <td className="px-3 py-2 text-muted-foreground">Avg P&amp;L delta</td>
                {thresholds.map((t) => {
                  const sim = reverseSimAll[t.key];
                  const delta = sim.deltaAvgPnlDollars;
                  const color = delta == null ? 'text-muted-foreground' :
                    delta > 0.005 ? 'text-chart-3' :
                    delta < -0.005 ? 'text-destructive' : 'text-muted-foreground';
                  return (
                    <td key={t.key} className={cn('px-3 py-2 text-right tabular-nums font-mono', color, colHighlight(t.key))}>
                      {delta != null ? formatSignedUsd(delta) : '—'}
                    </td>
                  );
                })}
              </tr>
              {/* Avg P&L / trade — YES actual */}
              <tr className="hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 text-muted-foreground">Avg YES P&amp;L</td>
                {thresholds.map((t) => {
                  const sim = reverseSimAll[t.key];
                  const v = sim.actualAvgPnlDollars;
                  const color = v == null ? 'text-muted-foreground' :
                    v > 0 ? 'text-chart-3' : v < 0 ? 'text-destructive' : 'text-muted-foreground';
                  return (
                    <td key={t.key} className={cn('px-3 py-2 text-right tabular-nums font-mono', color, colHighlight(t.key))}>
                      {v != null ? formatSignedUsd(v) : '—'}
                    </td>
                  );
                })}
              </tr>
              {/* Avg P&L / trade — sim NO */}
              <tr className="hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 text-muted-foreground">Avg sim NO P&amp;L</td>
                {thresholds.map((t) => {
                  const sim = reverseSimAll[t.key];
                  const v = sim.simAvgPnlDollars;
                  const color = v == null ? 'text-muted-foreground' :
                    v > 0 ? 'text-chart-3' : v < 0 ? 'text-destructive' : 'text-muted-foreground';
                  return (
                    <td key={t.key} className={cn('px-3 py-2 text-right tabular-nums font-mono', color, colHighlight(t.key))}>
                      {v != null ? formatSignedUsd(v) : '—'}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="px-4 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
        Sim P&amp;L is gross (no fees). NO entry at 100 − YES fill price. Only outcome-reconciled YES entries included.
        {thresholds.some((t) => reverseSimAll[t.key].sampleWarning === 'very_small' && reverseSimAll[t.key].count > 0) &&
          ' * fewer than 30 samples — treat as directional only.'}
      </div>
    </div>
  );
}

function useEntryGapReport(
  period: 'today' | '7d' | 'all-time',
): { data: EntryGapReport | null; loading: boolean } {
  const [data, setData] = useState<EntryGapReport | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const fetch_ = async () => {
      try {
        const url = `/api/trade/analytics/reports/entry-gap?period=${period}`;
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok && alive) setData(await r.json() as EntryGapReport);
      } catch { /* non-critical */ }
      if (alive) setLoading(false);
    };
    void fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [period]);
  return { data, loading };
}

interface EntryGapTrade {
  id:                   string;
  timestampMs:          number;
  ticker:               string;
  series:               string;
  side:                 string;
  triggerPriceCents:    number;
  fillPriceCents:       number;
  gapCents:             number;
  fallingKnife:         boolean;
  win:                  boolean | null;
  netPnlDollars:        number | null;
  /** 'limit_fallback' means fill price is estimated — reconciliation permanently failed. */
  fillPriceSource:      string | null;
  /** true when fill price is estimated (reconcile_failed=true OR fill_price_source='limit_fallback'). */
  estimatedFillPrice:   boolean;
  simNoEntryPriceCents: number | null;
  simNoPnlDollars:      number | null;
  simNoWin:             boolean | null;
}

const ALERT_LOG_TTL_MS = 24 * 60 * 60 * 1000;

function loadAlertLog(): AlertEntry[] {
  try {
    const raw = localStorage.getItem(ALERT_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Omit<AlertEntry, 'time'> & { time: number | string }>;
    const cutoff = Date.now() - ALERT_LOG_TTL_MS;
    return parsed
      .map((e) => ({
        ...e,
        // Prefer numeric epoch (new format); fall back to ISO string (legacy)
        time: new Date(typeof e.time === 'number' ? e.time : e.time),
      }))
      .filter((e): e is AlertEntry =>
        e.time.getTime() > cutoff &&
        (e.side === 'YES' || e.side === 'NO'),
      )
      .slice(0, ALERT_LOG_MAX);
  } catch {
    return [];
  }
}

const ALERT_LOG_MAX = 20;

/** Alias kept for internal component readability. */
type Phase4BEntryGapCoverageReport = EntryGapApiResponse;
const ENTRY_GAP_COVERAGE_REFRESH_MS = 5 * 60_000;

function entryGapStatusLabel(status: string): string {
  switch (status) {
    case 'confirmed_causal': return 'Confirmed causal';
    case 'prospective_no_causal': return 'Prospective (no causal pair)';
    case 'unavailable_source_missing': return 'Source missing';
    case 'unavailable_age_exceeded': return 'Age exceeded';
    case 'unavailable_no_snapshot': return 'No snapshot';
    default: return status.replace(/_/g, ' ');
  }
}

function formatEntryGapRowDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function EntryGapRowDetail({ row, isBackfill }: { row: Phase4BEntryGapRow | Phase4BEntryGapBackfillRow; isBackfill: boolean }) {
  const [open, setOpen] = useState(false);
  const qualColor = row.qualification === 'in_band_measurable'
    ? 'text-chart-3'
    : row.qualification === 'in_band_unavailable'
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-muted-foreground';

  return (
    <div className={cn(
      'border rounded-lg overflow-hidden text-xs',
      isBackfill
        ? 'border-purple-500/25 bg-purple-500/5'
        : 'border-border bg-background',
    )}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="font-mono text-foreground shrink-0">{row.ticker}</span>
        <span className={cn('shrink-0', qualColor)}>
          {row.entryPriceCents != null ? `${row.entryPriceCents}¢` : '—'}
        </span>
        {isBackfill && (
          <span className="ml-auto shrink-0 inline-flex items-center rounded-full border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
            Historical
          </span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground text-[10px]">
          {formatEntryGapRowDate(row.capturedAtMs)}
        </span>
        <span className="shrink-0 text-muted-foreground">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border pt-2 text-[11px]">
          <div><span className="text-muted-foreground">Side: </span><span className="font-medium uppercase">{row.side}</span></div>
          <div><span className="text-muted-foreground">Seconds left: </span><span className="font-mono">{row.secondsLeft}</span></div>
          <div><span className="text-muted-foreground">Threshold strike: </span><span className="font-mono">{row.thresholdStrike ?? '—'}</span></div>
          <div><span className="text-muted-foreground">Operator: </span><span className="font-mono">{row.comparisonOperator ?? '—'}</span></div>
          <div><span className="text-muted-foreground">Causal ref price: </span><span className="font-mono">{row.causalReferencePrice ?? '—'}</span></div>
          <div><span className="text-muted-foreground">Evidence status: </span><span className="font-mono">{row.causalEvidenceStatus}</span></div>
          <div><span className="text-muted-foreground">Ref age: </span><span className="font-mono">{row.causalReferenceAgeMs != null ? `${(row.causalReferenceAgeMs / 1000).toFixed(1)}s` : '—'}</span></div>
          <div><span className="text-muted-foreground">Signed gap: </span><span className={cn('font-mono', row.signedGapDollars != null && row.signedGapDollars < 0 ? 'text-destructive' : '')}>{row.signedGapDollars != null ? `$${row.signedGapDollars.toFixed(4)}` : '—'}</span></div>
          <div><span className="text-muted-foreground">Ref vs target: </span><span className="font-mono">{row.referenceVsTarget ?? '—'}</span></div>
          <div><span className="text-muted-foreground">Qualification: </span><span className={cn('font-mono', qualColor)}>{row.qualification}</span></div>
          {isBackfill && (
            <div className="col-span-2 mt-1 pt-1 border-t border-purple-500/20">
              <span className="text-muted-foreground">Backfill source: </span>
              <span className="font-mono text-purple-600 dark:text-purple-400">
                {(row as Phase4BEntryGapBackfillRow).backfillSource}
              </span>
              <span className="ml-2 text-muted-foreground text-[10px]">— historical reconstruction from persisted causal evidence</span>
            </div>
          )}
          {row.unavailableReasons.length > 0 && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Unavailable reasons: </span>
              <span className="font-mono text-yellow-600 dark:text-yellow-400">{row.unavailableReasons.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type EntryGapSortCol = 'ticker' | 'entryPrice' | 'gap' | 'capturedAt';
type EntryGapSortDir = 'asc' | 'desc';
type EntryGapSourceFilter = 'all' | 'live' | 'backfill';
type EntryGapQualFilter = 'all' | 'measurable' | 'unavailable';

interface EntryGapSortState { col: EntryGapSortCol; dir: EntryGapSortDir }

function EntryGapSortButton({
  col, label, sort, onSort,
}: {
  col: EntryGapSortCol;
  label: string;
  sort: EntryGapSortState;
  onSort: (col: EntryGapSortCol) => void;
}) {
  const active = sort.col === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={cn(
        'flex items-center gap-0.5 font-medium select-none hover:text-foreground transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
      <span className="text-[9px] leading-none ml-0.5">
        {active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </button>
  );
}

// ─── Market Data Coverage Panel ──────────────────────────────────────────────
//
// Surfaces final-window market-data gaps and their recovery outcomes so a
// missed setup is never mistaken for a deliberate strategy skip. Read-only:
// it never touches the browser trade alerts (fireAlert / AlertEntry).

const COVERAGE_REFRESH_MS = 15_000;

function MarketDataCoveragePanel() {
  const [response, setResponse] = useState<CoverageApiResponse | null>(null);
  const [fetched, setFetched] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const token = await getTradeToken();
        const res = await fetch('/api/trade/analytics/market-data-coverage', {
          cache: 'no-store',
          headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (!alive) return;
        setResponse(res.ok ? (await res.json() as CoverageApiResponse) : null);
      } catch {
        if (alive) setResponse(null); // fetch failure → explicit unknown state
      }
      if (alive) setFetched(true);
    };
    void load();
    const id = setInterval(() => { void load(); }, COVERAGE_REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!fetched) return null;

  const panel = deriveCoveragePanelState(response);
  // Healthy and quiet — stay out of the way.
  if (panel.severity === 'ok' && panel.incidents.length === 0 && panel.audits.length === 0) return null;

  const border =
    panel.severity === 'critical' ? 'border-destructive/70 shadow-[0_0_20px_2px] shadow-destructive/20' :
    panel.severity === 'warning'  ? 'border-yellow-500/60' :
    panel.severity === 'unknown'  ? 'border-yellow-500/40' : 'border-border';

  return (
    <section
      className={cn('border rounded-xl overflow-hidden', border)}
      aria-labelledby="market-data-coverage-title"
      data-testid="market-data-coverage-panel"
    >
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-start gap-2">
        <AlertTriangle className={cn(
          'h-4 w-4 mt-0.5 shrink-0',
          panel.severity === 'critical' ? 'text-destructive' : 'text-yellow-500',
        )} />
        <div>
          <div id="market-data-coverage-title" className="text-sm font-semibold text-foreground">
            Market Data Coverage
          </div>
          {panel.headline && (
            <p className={cn(
              'text-xs mt-0.5 font-medium',
              panel.severity === 'critical' ? 'text-destructive' : 'text-yellow-600 dark:text-yellow-400',
            )}>
              {panel.headline}
            </p>
          )}
          {response && (
            <p className="text-[11px] mt-1 text-muted-foreground">
              Audit source: {response.source === 'sql' ? 'SQL' : 'local fallback'} · retained {response.retentionDays ?? 8} days ·
              {response.evidenceCompleteness === 'complete' ? ' evidence complete' : ' restart continuity unknown'}
            </p>
          )}
        </div>
      </div>
      {panel.incidents.length > 0 && (
        <div className="divide-y divide-border">
          {panel.incidents.slice(0, 8).map((inc) => (
            <div key={inc.incidentId} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-mono text-foreground">{inc.ticker}</span>
              <span className={cn(
                'px-2 py-0.5 rounded-full font-semibold',
                inc.status === 'unresolved'
                  ? 'bg-destructive/10 text-destructive border border-destructive/30'
                  : inc.status === 'unrecovered_window_closed'
                    ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/30'
                    : 'bg-chart-3/10 text-chart-3 border border-chart-3/30',
              )}>
                {inc.status === 'unresolved' ? 'UNRESOLVED GAP'
                  : inc.status === 'unrecovered_window_closed' ? 'WINDOW CLOSED UNRECOVERED'
                  : 'RECOVERED'}
              </span>
              <span className="text-muted-foreground">
                detected {new Date(inc.detectedAtMs).toLocaleTimeString()} · T−{inc.secondsLeftAtDetect}s ·
                WS {inc.wsConnected ? 'connected' : 'disconnected'} · {describeRecovery(inc)}
              </span>
            </div>
          ))}
        </div>
      )}
      {panel.audits.length > 0 && (
        <div className="divide-y divide-border border-t border-border">
          {panel.audits.slice(0, 8).map((audit) => (
            <div key={audit.auditId} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-mono text-foreground">{audit.ticker}</span>
              <span className={cn(
                'px-2 py-0.5 rounded-full font-semibold',
                audit.status === 'HEALTHY'
                  ? 'bg-chart-3/10 text-chart-3 border border-chart-3/30'
                  : audit.status === 'DEGRADED_RECOVERED'
                    ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/30'
                    : audit.status === 'DEGRADED_UNRECOVERED'
                      ? 'bg-destructive/10 text-destructive border border-destructive/30'
                      : 'bg-muted text-muted-foreground border border-border',
              )}>
                {audit.status.replaceAll('_', ' ')}
              </span>
              <span className="text-muted-foreground">
                closed {new Date(audit.closeTime).toLocaleTimeString()} ·
                quotes {audit.finalWindowUsableQuotes} · evaluations {audit.finalWindowEvaluations} ·
                {audit.recoveryAttempts.length} recovery attempt{audit.recoveryAttempts.length === 1 ? '' : 's'} ·
                {audit.evidenceCompleteness === 'restart_continuity_unknown' ? ' restart continuity unknown' : ' evidence complete'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface PassiveProgramReadiness {
  researchOnly: boolean;
  executionBoundary: string;
  programs: Array<{
    program: string; name: string; experimentVersion: string; firstCapturedAtMs: number | null; lastCapturedAtMs: number | null;
    sample: { captured: number; eligible: number; settled: number };
    sourceHealth: { unavailable: number; staleReference: number; referenceErrors: number };
    promotionStage: string; promotionEligible: boolean; blockers: string[];
  }>;
  rankingStatus: string;
  rankings: Array<{ program: string; experimentVersion: string; counterfactualNetPnlChangeCents: number; drawdownChangeCents: number; evidence: string }>;
  externalSourceHealth: { sources: Array<{ source: string; state: string; availabilityTimestampMs: number | null; latencyMs: number | null; revisionState: string; insufficiencyReason: string }>; frozenHorizons: Array<{ seconds: number; eligible: boolean; reason: string }> };
  supportingResearch: string[];
  collectorHealth: { pairedSideLeadLag?: { observations: number; candidateObservations: number; repricingLeadCounts: { cheapSide: number; expensiveSide: number; ambiguous: number }; executionLabels: { successfulPairedExecution: number; freshnessFailure: number; secondLegBlocked: number; zeroOrPartialFill: number; unlabeled: number } } };
  researchInventory: Array<{ category: string; identifier: string; purpose: string; status: string; versionOrFrozenStart: string; observations: number | null; settledOutcomes: number | null; preliminaryResult: string; limitations: string[]; actionable: boolean; nextMilestone: string }>;
}

function PassiveProgramReadinessPanel() {
  const [report, setReport] = useState<PassiveProgramReadiness | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const token = await getTradeToken();
        const response = await fetch('/api/trade/phase4b-capture/passive-program-readiness', {
          cache: 'no-store', credentials: 'include', headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (response.ok && alive) setReport(await response.json() as PassiveProgramReadiness);
      } catch { /* a read-only research report must not disrupt market monitoring */ }
      finally { if (alive) setLoaded(true); }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!loaded) return null;
  if (!report) return <section className="border rounded-xl px-4 py-3 text-xs text-muted-foreground">Passive program readiness is currently unavailable.</section>;
  const stage = (value: string) => value.replaceAll('_', ' ');
  return (
    <section className="border rounded-xl overflow-hidden" aria-labelledby="passive-program-readiness-title" data-testid="passive-program-readiness">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap gap-3 justify-between">
        <div>
          <div id="passive-program-readiness-title" className="text-sm font-semibold">Passive Shadow Program Readiness</div>
          <p className="text-xs text-muted-foreground mt-0.5">Observed research evidence only — never an order, guard, exit, cooldown, or ranking input.</p>
        </div>
        <span className="text-[10px] uppercase font-semibold text-muted-foreground">No automatic promotion</span>
      </div>
      <div className="divide-y divide-border">
        {report.programs.map((program) => (
          <div key={program.experimentVersion} className="px-4 py-3 text-xs">
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
              <div><b>Program {program.program}</b> · {program.name} <span className="font-mono text-muted-foreground">{program.experimentVersion}</span></div>
              <span className="capitalize text-muted-foreground">{stage(program.promotionStage)}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1 text-muted-foreground">
              <span>Captured <b className="text-foreground">{program.sample.captured}</b></span><span>Eligible <b className="text-foreground">{program.sample.eligible}</b></span>
              <span>Settled <b className="text-foreground">{program.sample.settled}</b></span><span>Unavailable source <b className="text-foreground">{program.sourceHealth.unavailable}</b></span>
            </div>
            <div className="mt-1 text-muted-foreground">Started {program.firstCapturedAtMs ? new Date(program.firstCapturedAtMs).toLocaleString() : 'not yet captured'} · latest {program.lastCapturedAtMs ? new Date(program.lastCapturedAtMs).toLocaleString() : '—'}</div>
            {program.blockers.length > 0 && <div className="mt-1 text-yellow-600 dark:text-yellow-400">Blocked: {program.blockers.join('; ')}</div>}
          </div>
        ))}
      </div>
      <div className="px-4 py-3 bg-muted/10 text-xs text-muted-foreground">
        <b>Counterfactual ranking:</b> {report.rankingStatus === 'evidence_based_settlement_only'
          ? report.rankings.map((item) => `Program ${item.program}: P&L ${item.counterfactualNetPnlChangeCents}¢, drawdown ${item.drawdownChangeCents}¢`).join(' · ')
          : 'Unavailable: no qualifying settled counterfactual P&L/drawdown cohort.'}
        <div className="mt-1"><b>Program E sources:</b> {report.externalSourceHealth.sources.map((source) => `${source.source}: ${source.state} (${source.revisionState}; ${source.insufficiencyReason})`).join(' · ')}</div>
        <div className="mt-1">Frozen horizons: {report.externalSourceHealth.frozenHorizons.map((horizon) => `${horizon.seconds}s ${horizon.eligible ? 'eligible' : 'unavailable'}`).join(', ')}.</div>
        {report.collectorHealth.pairedSideLeadLag && <div className="mt-2"><b>Paired-side lead/lag (20–30¢ ↔ 70–80¢):</b> {report.collectorHealth.pairedSideLeadLag.observations} observations / {report.collectorHealth.pairedSideLeadLag.candidateObservations} executable candidates · repriced first: cheap {report.collectorHealth.pairedSideLeadLag.repricingLeadCounts.cheapSide}, expensive {report.collectorHealth.pairedSideLeadLag.repricingLeadCounts.expensiveSide}, ambiguous {report.collectorHealth.pairedSideLeadLag.repricingLeadCounts.ambiguous} · labels: completed {report.collectorHealth.pairedSideLeadLag.executionLabels.successfulPairedExecution}, freshness failures {report.collectorHealth.pairedSideLeadLag.executionLabels.freshnessFailure}, second-leg blocks {report.collectorHealth.pairedSideLeadLag.executionLabels.secondLegBlocked}, unlabeled {report.collectorHealth.pairedSideLeadLag.executionLabels.unlabeled}. Research-only; freshness failures are retained as observations.</div>}
        <div className="mt-1">Existing studies retained: {report.supportingResearch.join(' ')}</div>
        <details className="mt-2"><summary className="cursor-pointer font-semibold">All research programs & collection status</summary>
          <div className="mt-2 space-y-2">{report.researchInventory.map((item) => <div key={item.identifier} className="border-l-2 border-border pl-2">
            <b>{item.identifier}</b> · {item.category.replaceAll('_', ' ')} · {item.status.replaceAll('_', ' ')}
            <div>{item.purpose} · version/start: {item.versionOrFrozenStart} · observations: {item.observations ?? 'collector/report-level'} · settled: {item.settledOutcomes ?? 'not separately retained'}</div>
            <div>Result: {item.preliminaryResult} Next: {item.nextMilestone}</div>
            {item.limitations.length > 0 && <div>Limits: {item.limitations.join('; ')}</div>}
          </div>)}</div>
        </details>
      </div>
    </section>
  );
}

function CompactShadowCollectionPanel() {
  const [status, setStatus] = useState<CompactShadowStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch('/api/trade/analytics/compact-shadow/status', { cache: 'no-store' });
        const body = response.ok ? await response.json() as CompactShadowStatus : null;
        if (alive) setStatus(body);
      } catch {
        if (alive) setStatus(null);
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 20_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!loaded) return null;
  const assets = status?.assets ?? [];
  const experiment = status?.normalizedDistanceExperiment;
  const percent = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
  return (
    <section className="border rounded-xl overflow-hidden" aria-labelledby="compact-shadow-collection-title" data-testid="compact-shadow-collection-panel">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-start justify-between gap-3">
        <div>
          <div id="compact-shadow-collection-title" className="text-sm font-semibold text-foreground">Compact Shadow Collection</div>
          <p className="text-xs text-muted-foreground mt-0.5">Research-only Coinbase features and Kalshi outcome labels — never used for trading.</p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">No execution gate</span>
      </div>
      {!status ? <p className="px-4 py-3 text-xs text-muted-foreground">Collection status is currently unavailable.</p> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x">
          {(['BTC', 'ETH'] as const).map((asset) => {
            const row = assets.find((item) => item.asset === asset);
            const health = row?.latest_health;
            const state = health?.status ?? 'waiting';
            return <div key={asset} className="px-4 py-3 text-xs space-y-1.5">
              <div className="flex justify-between font-semibold"><span>{asset}</span><span className={state === 'fresh' ? 'text-chart-3' : 'text-yellow-500'}>{state}</span></div>
              <div className="grid grid-cols-2 gap-x-3 text-muted-foreground">
                <span>Snapshots <b className="text-foreground">{row?.snapshot_count ?? 0}</b></span>
                <span>Markets <b className="text-foreground">{row?.market_count ?? 0}</b></span>
                <span>Outcomes <b className="text-foreground">{row?.resolved_outcome_count ?? 0}</b></span>
                <span>Pending <b className="text-foreground">{row?.pending_outcome_market_count ?? 0}</b></span>
              </div>
              <div className="text-muted-foreground">Feed: {health?.connected ? 'connected' : 'not connected'}{row?.last_snapshot_ms ? ` · ${new Date(row.last_snapshot_ms).toLocaleTimeString()}` : ''}</div>
            </div>;
          })}
        </div>
      )}
      {status && (
        <div className="border-t border-border px-4 py-3" data-testid="normalized-distance-experiment">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <div>
              <div className="text-sm font-semibold">Prospective normalized-distance experiment</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Frozen from {experiment ? new Date(experiment.startMs).toLocaleString() : '—'} · YES ≥ +0.25 · NO ≤ −0.25 volatility units · research only
              </p>
            </div>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Future cohort only</span>
          </div>
          {!experiment || experiment.cohorts.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">Waiting for the first complete future-market snapshot.</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x border rounded-lg overflow-hidden">
              {(['BTC', 'ETH', 'combined'] as const).map((asset) => {
                const cohort = experiment.cohorts.find((item) => item.asset === asset);
                return (
                  <div key={asset} className="p-3 text-xs">
                    <div className="font-semibold">{asset === 'combined' ? 'Combined' : asset}</div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                      <span>Enrolled <b className="text-foreground">{cohort?.enrolled_count ?? 0}</b></span>
                      <span>Settled <b className="text-foreground">{cohort?.settled_count ?? 0}</b></span>
                      <span>Directional <b className="text-foreground">{cohort?.directional_count ?? 0}</b></span>
                      <span>Neutral <b className="text-foreground">{cohort?.neutral_count ?? 0}</b></span>
                    </div>
                    <div className="mt-2 text-muted-foreground">
                      Accuracy <b className="text-foreground">{percent(cohort?.directional_accuracy)}</b>
                      {cohort?.directional_wilson_95.low != null && ` (95% ${percent(cohort.directional_wilson_95.low)}–${percent(cohort.directional_wilson_95.high)})`}
                    </div>
                    <div className="mt-1 text-muted-foreground">YES call {percent(cohort?.yes_accuracy)} ({cohort?.yes_call_count ?? 0}) · NO call {percent(cohort?.no_accuracy)} ({cohort?.no_call_count ?? 0})</div>
                    {(cohort?.unavailable_without_eligible_enrollment_count ?? 0) > 0 && <div className="mt-1 text-yellow-600 dark:text-yellow-400">Observed, not enrolled: {cohort!.unavailable_without_eligible_enrollment_count}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function EntryGapCoveragePanel() {
  const [data, setData] = useState<Phase4BEntryGapCoverageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<EntryGapSortState>({ col: 'capturedAt', dir: 'desc' });
  const [sourceFilter, setSourceFilter] = useState<EntryGapSourceFilter>('all');
  const [qualFilter, setQualFilter] = useState<EntryGapQualFilter>('all');

  useEffect(() => {
    let alive = true;
    const load = async (initial: boolean) => {
      if (initial) setLoading(true);
      try {
        const token = await getTradeToken();
        const response = await fetch('/api/trade/phase4b-capture/entry-gap-report', {
          cache: 'no-store',
          headers: token ? { 'X-Trade-Token': token } : undefined,
        });
        if (response.ok && alive) setData(await response.json() as Phase4BEntryGapCoverageReport);
      } catch { /* passive research panel must never interrupt the dashboard */ }
      if (alive) setLoading(false);
    };
    void load(true);
    const intervalId = setInterval(() => { void load(false); }, ENTRY_GAP_COVERAGE_REFRESH_MS);
    return () => { alive = false; clearInterval(intervalId); };
  }, []);

  const handleSort = useCallback((col: EntryGapSortCol) => {
    setSort((prev) => prev.col === col
      ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: col === 'capturedAt' ? 'desc' : 'asc' },
    );
  }, []);

  const allRows = useMemo(() => {
    if (!data) return [];
    const live = (data.rows ?? []).map((r) => ({ row: r, isBackfill: false as const }));
    const backfill = (data.backfillRows ?? []).map((r) => ({ row: r, isBackfill: true as const }));
    return [...live, ...backfill];
  }, [data]);

  const filteredRows = useMemo(() => {
    let rows = allRows;

    if (sourceFilter === 'live') rows = rows.filter((r) => !r.isBackfill);
    else if (sourceFilter === 'backfill') rows = rows.filter((r) => r.isBackfill);

    if (qualFilter === 'measurable') rows = rows.filter((r) => r.row.qualification === 'in_band_measurable');
    else if (qualFilter === 'unavailable') rows = rows.filter((r) => r.row.qualification !== 'in_band_measurable');

    return [...rows].sort((a, b) => {
      let cmp = 0;
      switch (sort.col) {
        case 'ticker':
          cmp = a.row.ticker.localeCompare(b.row.ticker);
          break;
        case 'entryPrice':
          cmp = (a.row.entryPriceCents ?? -Infinity) - (b.row.entryPriceCents ?? -Infinity);
          break;
        case 'gap':
          cmp = (a.row.signedGapDollars ?? -Infinity) - (b.row.signedGapDollars ?? -Infinity);
          break;
        case 'capturedAt':
          cmp = a.row.capturedAtMs - b.row.capturedAtMs;
          break;
      }
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [allRows, sourceFilter, qualFilter, sort]);

  if (loading && !data) return (
    <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">
      Checking entry-gap evidence coverage…
    </div>
  );
  if (!data) return (
    <div className="border border-border rounded-xl px-4 py-6 text-center text-xs text-muted-foreground">
      Entry-gap evidence report is unavailable.
    </div>
  );

  const {
    liveCount, backfillCount, allMeasurable, hasUnavailable, noData, statusEntries,
  } = deriveEntryGapPanelState(data);
  const s = data.summary;

  const sourceOptions: { value: EntryGapSourceFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'live', label: `Live (${liveCount})` },
    { value: 'backfill', label: `Historical (${backfillCount})` },
  ];
  const qualOptions: { value: EntryGapQualFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'measurable', label: `Measurable (${s.measurable})` },
    { value: 'unavailable', label: `Unavailable (${s.unavailable})` },
  ];

  return (
    <section className="border border-border rounded-xl overflow-hidden" aria-labelledby="entry-gap-coverage-title" data-testid="entry-gap-coverage-panel">
      <div className="px-4 py-3 bg-muted/30 border-b border-border flex flex-wrap gap-3 items-start justify-between">
        <div>
          <div id="entry-gap-coverage-title" className="text-sm font-semibold text-foreground">Entry-Gap Evidence Coverage</div>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-3xl">
            90–95¢ in-band cases and whether each had a causal reference price available at entry time.
            Unavailable cases mean the gap could not be measured — watch this number as new cases arrive.
          </p>
        </div>
        <span className={cn(
          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
          noData
            ? 'text-muted-foreground bg-muted border-border'
            : hasUnavailable
              ? 'text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/25'
              : 'text-chart-3 bg-chart-3/10 border-chart-3/25',
        )}>
          {noData ? 'No cases yet' : allMeasurable ? 'Fully measurable' : `${s.unavailable} unavailable`}
        </span>
      </div>

      {/* Summary stats — 5 cells: combined totals + live/backfill split */}
      <div className="grid sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-border border-b border-border">
        {([
          ['In-band total', s.inBandTotal, false],
          ['Measurable', s.measurable, false],
          ['Unavailable', s.unavailable, true],
          ['Live captures', liveCount, false],
          ['Historical', backfillCount, false],
        ] as [string, number, boolean][]).map(([label, value, warn]) => (
          <div key={label} className={cn('px-4 py-3', label === 'Historical' && backfillCount > 0 ? 'bg-purple-500/5' : '')}>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              {label}
              {label === 'Historical' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500/60" />}
            </div>
            <div className={cn(
              'font-mono font-semibold mt-0.5 text-lg',
              warn && value > 0 ? 'text-yellow-600 dark:text-yellow-400' : '',
              label === 'Historical' && value > 0 ? 'text-purple-600 dark:text-purple-400' : '',
            )}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {statusEntries.length > 0 && (
        <div className="p-4 border-b border-border">
          <div className="text-xs font-medium text-foreground mb-2">Evidence status breakdown</div>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {statusEntries.map(([status, count]) => (
              <div key={status} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground truncate">{entryGapStatusLabel(status)}</span>
                <span className="font-mono font-medium text-foreground shrink-0">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter + sort controls */}
      {allRows.length > 0 && (
        <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex flex-wrap items-center gap-x-5 gap-y-2">
          {/* Source filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</span>
            <div className="flex rounded-md overflow-hidden border border-border text-[10px]">
              {sourceOptions.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSourceFilter(value)}
                  className={cn(
                    'px-2 py-0.5 transition-colors',
                    sourceFilter === value
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-background text-muted-foreground hover:bg-muted',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Qualification filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Show</span>
            <div className="flex rounded-md overflow-hidden border border-border text-[10px]">
              {qualOptions.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setQualFilter(value)}
                  className={cn(
                    'px-2 py-0.5 transition-colors',
                    qualFilter === value
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-background text-muted-foreground hover:bg-muted',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Sort controls */}
          <div className="flex items-center gap-2 ml-auto text-[10px]">
            <span className="uppercase tracking-wide text-muted-foreground">Sort</span>
            <EntryGapSortButton col="ticker" label="Ticker" sort={sort} onSort={handleSort} />
            <EntryGapSortButton col="entryPrice" label="Price" sort={sort} onSort={handleSort} />
            <EntryGapSortButton col="gap" label="Gap" sort={sort} onSort={handleSort} />
            <EntryGapSortButton col="capturedAt" label="Time" sort={sort} onSort={handleSort} />
          </div>
        </div>
      )}

      {/* Unified sorted + filtered rows */}
      {allRows.length > 0 && (
        <div className="p-4 border-b border-border">
          {filteredRows.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No rows match the current filters.</div>
          ) : (
            <div className="space-y-1.5">
              {filteredRows.map(({ row, isBackfill }) => (
                <EntryGapRowDetail key={`${isBackfill ? 'bf' : 'lv'}-${row.snapshotId}`} row={row} isBackfill={isBackfill} />
              ))}
            </div>
          )}
          <div className="mt-2 text-[10px] text-muted-foreground text-right">
            {filteredRows.length} of {allRows.length} rows
          </div>
        </div>
      )}

      <div className="px-4 py-2.5 bg-yellow-500/5 border-t border-yellow-500/15 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Observation only.</span>{' '}
        Reports capture quality for hypothesis <span className="font-mono">{data.hypothesisVersion}</span>; it cannot modify qualification, gates, or order submission.
      </div>
    </section>
  );
}

// Eth30Report is imported from @/lib/eth30FeeWarning (see import block above).
