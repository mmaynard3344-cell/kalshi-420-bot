/**
 * Display-state helpers for the ETH 30–50 fee-missing warning indicators.
 *
 * These functions derive every warning signal shown in the ETH 30–50 dashboard
 * section from the report's feesIncluded flag and per-row fee coverage fields.
 * Centralising them here lets the test import and exercise source-owned logic.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Eth30TickerRow {
  ticker: string;
  easternDate: string;
  side: 'yes' | 'no' | null;
  entryContracts: number;
  entryCostCents: number;
  entryAvgPriceCents: number | null;
  exitContracts: number;
  exitProceedsCents: number;
  settlementResult: 'yes' | 'no' | null;
  settledContracts: number;
  settlementPayoutCents: number;
  openContracts: number;
  cashFlowPnlCents?: number;
  realizedPnlCents: number | null;
  /** Total exchange fees for all fill events on this ticker, in cents. Null if any fill lacks fee data. */
  totalFeeCents: number | null;
  /** Net P&L after exchange fees. Null when totalFeeCents is null. */
  netPnlCents: number | null;
  /** True when every fill chunk for this ticker has fee data. */
  feesIncluded: boolean;
  /** True when at least one fill chunk has fee data (partial coverage). */
  anyFeesCaptured: boolean;
  status: 'no_fill' | 'open' | 'closed' | 'settled';
  firstExecutable50AtMs: number | null;
}

export interface Eth30Report {
  strategy: string;
  source: string;
  /** True once every fill event for every filled ticker carries an exchange fee from the Kalshi fills API. */
  feesIncluded: boolean;
  tickers: Eth30TickerRow[];
  summary: {
    claimedTickers: number;
    tickersWithFills: number;
    entryContracts: number;
    entryCostCents: number;
    exitProceedsCents: number;
    settlementPayoutCents: number;
    openContracts: number;
    cashFlowPnlCents?: number;
    realizedPnlCents: number | null;
    /** Total exchange fees across all filled tickers in cents. Null = any fill lacking fee data. */
    totalFeeCents: number | null;
    /** Net P&L after all exchange fees. Null when totalFeeCents is null. */
    netPnlCents: number | null;
    settledTickers: number;
    wins: number;
    losses: number;
    staleNoFillTickers?: string[];
    anyFeesCaptured?: boolean;
  };
}

// ─── Weekly aggregation ───────────────────────────────────────────────────────

export interface Eth30WeekSummary {
  /** Null unless every filled row is financially reconciled. */
  grossPnl: number | null;
  /**
   * Net P&L after exchange fees. Null whenever any constituent filled row
   * has incomplete fee coverage (feesIncluded=false) — never a mix of
   * exact-net and gross-fallback rows.
   */
  netPnl: number | null;
  /** Sum of totalFeeCents across rows that have fee data. */
  fees: number;
  /** True iff every filled row has feesIncluded=true. */
  allFeesIncluded: boolean;
  /** True iff at least one filled row has anyFeesCaptured=true. */
  anyFeesCaptured: boolean;
  /** Settled rows with positive display P&L (net when allFeesIncluded, gross otherwise). */
  wins: number;
  /** Settled rows with negative display P&L (net when allFeesIncluded, gross otherwise). */
  losses: number;
}

/**
 * Aggregate per-ticker rows into a weekly subtotal.
 *
 * Weekly completeness is gated on `row.feesIncluded`, which is true only when
 * ALL fill chunks for a row carry exchange fee data from the Kalshi fills API.
 * `row.anyFeesCaptured` (partial coverage) does NOT satisfy completeness —
 * a row with one fee-populated chunk and one null-fee chunk has
 * `anyFeesCaptured=true` but `feesIncluded=false` and contributes a null
 * `netPnlCents`. Propagating null prevents silently showing a mixed
 * gross+net sum as if it were an exact net figure.
 */
export function computeEth30WeekSummary(rows: Eth30TickerRow[]): Eth30WeekSummary {
  const filled = rows.filter(r => r.entryContracts > 0);
  const allFeesIncluded = filled.length > 0 && filled.every(r => r.feesIncluded);
  const allFinanciallyReconciled = filled.length > 0 && filled.every(r => r.realizedPnlCents !== null);
  const anyFeesCaptured = filled.some(r => r.anyFeesCaptured);
  const grossPnl = allFinanciallyReconciled
    ? filled.reduce((s, r) => s + (r.realizedPnlCents ?? 0), 0)
    : null;
  // netPnl is null whenever any row lacks complete fee coverage — never silently
  // fall back to realizedPnlCents, which would make a partial sum appear exact.
  const netPnl = allFeesIncluded && allFinanciallyReconciled
    ? filled.reduce((s, r) => s + (r.netPnlCents ?? 0), 0)
    : null;
  const fees = filled.reduce((s, r) => s + (r.totalFeeCents ?? 0), 0);
  const settled = filled.filter(r => r.status === 'settled');
  // W/L classification uses net when all fees known, gross otherwise
  const displayPnl = (r: Eth30TickerRow) =>
    allFeesIncluded ? r.netPnlCents : r.realizedPnlCents;
  const wins = settled.filter(r => (displayPnl(r) ?? 0) > 0).length;
  const losses = settled.filter(r => (displayPnl(r) ?? 0) < 0).length;
  return { grossPnl, netPnl, fees, allFeesIncluded, anyFeesCaptured, wins, losses };
}

// ─── Header badge ─────────────────────────────────────────────────────────────

/**
 * Text for the fee-status badge in the ETH 30–50 section header.
 *   feesIncluded=true              → 'NET OF FEES'
 *   feesIncluded=false, fills > 0 → 'FEES PARTIAL'
 *   feesIncluded=false, no fills  → 'GROSS OF FEES'
 */
export function eth30HeaderBadgeText(report: Eth30Report): string {
  if (report.feesIncluded) return 'NET OF FEES';
  return report.summary.tickersWithFills > 0 ? 'FEES PARTIAL' : 'GROSS OF FEES';
}

// ─── Summary P&L tile ─────────────────────────────────────────────────────────

/**
 * Label for the summary P&L tile.
 * feesIncluded=true → 'Net P&L', false → 'Gross P&L'.
 */
export function eth30SummaryPnlLabel(report: Eth30Report): string {
  return report.feesIncluded ? 'Net P&L' : 'Gross P&L';
}

/**
 * Value (in cents) shown in the summary P&L tile.
 * feesIncluded=true → netPnlCents (with gross fallback), false → realizedPnlCents (gross).
 */
export function eth30SummaryPnlCents(report: Eth30Report): number | null {
  return report.feesIncluded
    ? (report.summary.netPnlCents ?? report.summary.realizedPnlCents)
    : report.summary.realizedPnlCents;
}

// ─── Table column & header indicators ────────────────────────────────────────

/**
 * Whether to render the extra "Gross P&L" column in the ticker table.
 * True when feesIncluded=false so the unambiguous gross figure stays visible.
 */
export function eth30ShowsGrossPnlColumn(report: Eth30Report): boolean {
  return !report.feesIncluded;
}

/**
 * Whether the "Net P&L" column header should carry an asterisk warning.
 * True when feesIncluded=false.
 */
export function eth30NetPnlHeaderHasAsterisk(report: Eth30Report): boolean {
  return !report.feesIncluded;
}

// ─── Fees-paid tile annotation ────────────────────────────────────────────────

/**
 * Whether to show the amber "partial" annotation next to the fees-paid figure.
 * True when feesIncluded=false AND at least one ticker has fill data.
 */
export function eth30FeesPaidShowsPartialAnnotation(report: Eth30Report): boolean {
  return !report.feesIncluded && report.summary.tickersWithFills > 0;
}

// ─── Footer note ──────────────────────────────────────────────────────────────

/**
 * Which footer note to render below the ticker table.
 *   feesIncluded=true  → 'net-formula'  (clean accounting identity)
 *   feesIncluded=false → 'fee-warning'  (asterisk disclaimer)
 */
export function eth30FooterNoteKind(report: Eth30Report): 'net-formula' | 'fee-warning' {
  return report.feesIncluded ? 'net-formula' : 'fee-warning';
}

// ─── Per-row cell kinds ───────────────────────────────────────────────────────

/**
 * Presentation kind for the per-row net P&L cell.
 *   'net'        – full net value; fees are confirmed complete for this row
 *   'partial'    – value shown with amber "partial" label (some fees missing)
 *   'not-loaded' – no fee data at all; value would be misleading
 *   'dash'       – row has no entry fills; nothing to show
 */
export function eth30RowNetPnlCellKind(
  row: Eth30TickerRow,
): 'net' | 'partial' | 'not-loaded' | 'dash' {
  if (row.entryContracts === 0) return 'dash';
  if (row.feesIncluded) return 'net';
  if (row.anyFeesCaptured) return 'partial';
  return 'not-loaded';
}

/**
 * Presentation kind for the per-row fee cell.
 *   'amount'     – known fee amount is shown
 *   'not-loaded' – no fee data captured yet for this row
 *   'dash'       – row has no entry fills
 */
export function eth30RowFeeCellKind(
  row: Eth30TickerRow,
): 'amount' | 'not-loaded' | 'dash' {
  if (row.entryContracts === 0) return 'dash';
  return row.anyFeesCaptured ? 'amount' : 'not-loaded';
}
