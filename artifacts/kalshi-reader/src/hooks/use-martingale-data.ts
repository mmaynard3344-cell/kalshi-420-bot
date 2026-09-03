import { useQuery } from '@tanstack/react-query';
import { getTradeToken } from '@/lib/tradeToken';
import type { MartingaleStatus } from '@/lib/martingaleStatus';

export type { MartingaleStatus } from '@/lib/martingaleStatus';

const MARTINGALE_REQUEST_TIMEOUT_MS = 8_000;

export interface MartingaleBalance {
  balance?: number;
  balance_dollars?: string;
  portfolio_value?: number;
  stale?: boolean;
  aggregate_balance_cents?: number | null;
  aggregate_balance_dollars?: string | null;
  active_eth_exchange_index?: number | null;
  active_eth_exchange_balance?: {
    exchange_index: number;
    available_balance_cents: number | null;
    available_balance_dollars: string | null;
    stale: boolean;
  } | null;
  balance_breakdown?: Array<{
    exchange_index?: number;
    balance?: string | number;
    balance_dollars?: string;
  }>;
}

export interface MartingalePosition {
  ticker: string;
  position_fp: string;
  market_exposure_dollars?: string | null;
  total_traded_dollars?: string | null;
  realized_pnl_dollars?: string | null;
  fees_paid_dollars?: string | null;
  last_updated_ts?: string | null;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  market_status?: string;
  market_result?: string;
  close_time?: string;
}

export interface MartingaleLedgerOrder {
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  martingaleStep: number;
  requestedContracts: number;
  filledContracts: number | null;
  actualNotionalDollars: number | null;
  actualFeeDollars: number | null;
  settlementResult: 'yes' | 'no' | 'manual_yes' | 'manual_no' | null;
  outcome: string;
  createdAtMs: number;
}

export interface MartingaleOpenPosition {
  ticker: string;
  side: 'yes' | 'no';
  requested_contracts: number;
  filled_contracts: number;
  remaining_contracts: number;
  actual_notional_dollars: number | null;
  outcome: string;
  created_at_ms: number;
}

export interface MartingaleLedger {
  eastern_date: string;
  state: {
    next_side: 'yes' | 'no';
    martingale_step: number;
    next_principal_cents: number;
    realized_pnl_dollars: number;
  };
  session: {
    order_count: number;
    wins: number;
    losses: number;
    streak: number;
    streak_type: 'win' | 'loss' | null;
    filled_contracts: number;
    actual_notional_dollars: number;
    fill_economics_verified: boolean;
  };
  session_profit: {
    started_at_ms: number;
    realized_pnl_dollars: number | null;
    settled_order_count: number;
    fill_economics_verified: boolean;
  };
  open_position: MartingaleOpenPosition | null;
  manual_recovery_tickers: string[] | null;
  manual_recovery: {
    id: string;
    ticker: string;
    eastern_date: string;
    declared_result: 'yes' | 'no';
    reason: string;
    exchange_status: string;
    exchange_result: 'yes' | 'no' | null;
    created_at_ms: number;
  } | null;
  orders: MartingaleLedgerOrder[];
}

async function fetchWithToken(url: string) {
  const token = await getTradeToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['X-Trade-Token'] = token;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), MARTINGALE_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request to ${url} timed out after ${MARTINGALE_REQUEST_TIMEOUT_MS / 1000} seconds`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function useMartingaleData() {
  const balanceQuery = useQuery({
    queryKey: ['martingale', 'balance'],
    queryFn: () => fetchWithToken('/api/trade/balance') as Promise<MartingaleBalance>,
    refetchInterval: 10000,
    retry: false,
  });

  const statusQuery = useQuery({
    queryKey: ['martingale', 'status'],
    queryFn: () => fetchWithToken('/api/trade/status') as Promise<MartingaleStatus>,
    refetchInterval: 10000,
    retry: false,
  });

  const positionsQuery = useQuery({
    queryKey: ['martingale', 'positions'],
    queryFn: () => fetchWithToken('/api/trade/positions') as Promise<{ market_positions?: MartingalePosition[]; stale?: boolean }>,
    refetchInterval: 5000,
    retry: false,
  });

  const ledgerQuery = useQuery({
    queryKey: ['martingale', 'ledger'],
    queryFn: () => fetchWithToken('/api/trade/martingale') as Promise<MartingaleLedger>,
    refetchInterval: 10000,
    retry: false,
  });

  const isStale = balanceQuery.data?.stale || positionsQuery.data?.stale;
  
  const isLoading = 
    balanceQuery.isLoading || 
    statusQuery.isLoading || 
    positionsQuery.isLoading || 
    ledgerQuery.isLoading;

  const isError = 
    balanceQuery.isError || 
    statusQuery.isError || 
    positionsQuery.isError || 
    ledgerQuery.isError;

  return {
    balance: balanceQuery.data,
    status: statusQuery.data,
    positions: positionsQuery.data,
    ledger: ledgerQuery.data,
    ledgerError: ledgerQuery.error,
    isLedgerLoading: ledgerQuery.isLoading,
    isLedgerError: ledgerQuery.isError,
    isLoading,
    isError,
    isStale,
    refetchAll: () => Promise.all([
      balanceQuery.refetch(),
      statusQuery.refetch(),
      positionsQuery.refetch(),
      ledgerQuery.refetch(),
    ])
  };
}
