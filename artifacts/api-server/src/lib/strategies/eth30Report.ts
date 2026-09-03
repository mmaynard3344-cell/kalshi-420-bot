/**
 * ETH_30_50 strategy-only reporting.
 *
 * The report is computed EXCLUSIVELY from the isolated eth30_* ownership
 * ledgers (ticker claims, strategy orders, position events, decision events).
 * Legacy ETH order_attempts / order_fills rows are never consulted, so legacy
 * ETH activity can never be attributed to this strategy.
 *
 * P&L convention (exact, per owned fill chunk, cents):
 *   entry cost      = Σ entry_fill  (fillPriceCents × contractsDelta)
 *   exit proceeds   = Σ exit_fill   (fillPriceCents × |contractsDelta|)
 *   settlement pay  = settled contracts × 100¢ when held side === market result,
 *                     else 0¢.
 *   gross P&L       = exit proceeds + settlement payout − entry cost.
 *   total fees      = Σ feeCents across all fill events (entry + exit) for this ticker.
 *   net P&L         = gross P&L − total fees.
 *
 * feesIncluded is true when every fill event for every filled ticker carries a
 * non-null feeCents value (i.e. the canonical rebuild has run with fee capture
 * enabled). Legacy rows written before fee capture will have feeCents=null and
 * cause feesIncluded to remain false until the canonical rebuild refreshes them.
 */
import type {
  Eth30TickerClaim,
  Eth30StrategyOrder,
  Eth30PositionEventParams,
  Eth30DecisionEventParams,
} from "../tradeStore.js";
import {
  ETH30_STRATEGY_ID,
  eth30EntryPolicy,
  eth30EntryPriceBucket,
  type Eth30EntryPriceBucket,
} from "./eth30_50Rules.js";


export interface Eth30FillChunk {
  eventId:        string;

  role:           "entry" | "exit";

  contracts:      number;

  priceCents:     number;

  costCents:      number;   // signed strategy cash flow: entry negative, exit positive
  /** Exchange fee for this chunk in cents. Null for legacy events pre-dating fee capture. */

  feeCents:       number | null;

  occurredAtMs:   number;

  note:           string | null;
}

/**
 * A claimed ticker is considered "stale no-fill" when it has no entry fills
 * and the claim is older than this threshold. Used to surface orphaned claims
 * that were never filled (zero-fill IOC, exchange rejection, etc.).
 */
export const STALE_NO_FILL_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
export interface Eth30TickerReport {
  ticker:               string;

  easternDate:          string;

  claimedAtMs:          number;

  side:                 "yes" | "no" | null;
  /** Every outcome with a durable entry for this ticker. A paired market has
   * both values even though the legacy `side` field remains nullable. */
  sides:                Array<"yes" | "no">;

  entryContracts:       number;

  entryCostCents:       number;

  entryAvgPriceCents:   number | null;
  /** Bucket based on the approved entry order price, not an inferred legacy fill. */
  entryPriceBucket:     Eth30EntryPriceBucket | null;

  exitContracts:        number;

  exitProceedsCents:    number;

  settlementResult:     "yes" | "no" | null;

  settledContracts:     number;

  settlementPayoutCents: number;

  openContracts:        number;

  /** Cash-flow total before the market is fully reconciled; never use as realized P&L. */
  cashFlowPnlCents:     number;
  /** Null until all fill fees and final position evidence are complete. */
  realizedPnlCents:     number | null;
  /** Total exchange fees for all fill events on this ticker, in cents.
   *  Null if any fill event lacks fee data (legacy rows). */

  netPnlCents:          number | null;

  feesIncluded:         boolean;
  /**
   * True when at least one fill chunk has non-null feeCents. Useful for
   * distinguishing "fees partially loaded" (anyFeesCaptured && !feesIncluded)
   * from "no fee data at all" (!anyFeesCaptured).
   */

  anyFeesCaptured:      boolean;
  /**
   * True only when every entry/exit fill has fee evidence and no owned quantity
   * remains after a closed target or settlement. Only these rows may contribute
   * to price-tier realized-P&L metrics.
   */
  financiallyReconciled: boolean;

  status:               "no_fill" | "open" | "closed" | "settled";
  /**
   * True when status is "no_fill" and the claim is older than
   * STALE_NO_FILL_THRESHOLD_MS. These are candidates for manual release via the
   * admin endpoint so the ticker can be re-evaluated.
   */

  isStaleNoFill:        boolean;

  firstExecutable50AtMs: number | null;

  fills:                Eth30FillChunk[];

  decisions:            Eth30DecisionEventParams[];

  totalFeeCents:        number | null;
  /** Net P&L after exchange fees: realizedPnlCents − totalFeeCents.
   *  Null when totalFeeCents is null (fees not yet captured for all fills). */
}

export interface Eth30PriceBandMetrics {
  trades: number;
  fullyReconciledMarkets: number;
  targetHits: number;
  targetHitRate: number | null;
  principalCents: number;
  feesCents: number;
  netPnlCents: number;
  roiPercent: number | null;
  averagePnlCents: number | null;
}

export interface Eth30Report {
  strategy:        typeof ETH30_STRATEGY_ID;
  entryPolicy:     ReturnType<typeof eth30EntryPolicy>;
  /** Every number below derives ONLY from eth30_* ownership rows. */

  source:          "eth30_owned_ledgers_only";
  /** True once every fill event for every filled ticker carries an exchange fee
   *  from the Kalshi fills API (feeCents non-null). False while any legacy row
   *  without fee data exists — the canonical rebuild will populate them. */

  feesIncluded:    boolean;

  generatedAtMs:   number;

  tickers:         Eth30TickerReport[];

  recentDecisions: Eth30DecisionEventParams[];
  priceBandBreakdown: {
    "23_25": Eth30PriceBandMetrics;
    "26_28": Eth30PriceBandMetrics;
    "23_28_combined": Eth30PriceBandMetrics;
    rejectedOpportunities: Array<{
      bucket: Exclude<Eth30EntryPriceBucket, "23_25" | "26_28">;
      opportunities: number;
      rejectionReasons: Record<string, number>;
    }>;
  };

  summary: {
    claimedTickers:        number;
    tickersWithFills:      number;
    /** Claimed tickers with no entry fills and a claim age > STALE_NO_FILL_THRESHOLD_MS. */
    staleNoFillTickers:    number;
    entryContracts:        number;
    entryCostCents:        number;
    exitProceedsCents:     number;
    settlementPayoutCents: number;
    openContracts:         number;
    /** Cash-flow total before final reconciliation; never use as realized P&L. */
    cashFlowPnlCents:      number;
    realizedPnlCents:      number | null;
    /** Total exchange fees across all filled tickers. Null when any fill lacks fee data. */
    totalFeeCents:         number | null;
    /** Net P&L after all exchange fees. Null when any fill lacks fee data. */
    netPnlCents:           number | null;
    settledTickers:        number;
    wins:                  number;
    losses:                number;
  };
}

export interface Eth30ReportInputs {
  claims:           Eth30TickerClaim[];
  ordersByTicker:   Map<string, Eth30StrategyOrder[]>;
  eventsByTicker:   Map<string, Eth30PositionEventParams[]>;
  decisionsByTicker: Map<string, Eth30DecisionEventParams[]>;
  recentDecisions?: Eth30DecisionEventParams[];
  nowMs?:           number;
}

/**
 * Pure report builder over already-loaded eth30 rows. Only tickers with a
 * durable claim are reported; events for unclaimed tickers are ignored — a
 * structural guarantee of isolation from legacy ETH orders.
 */
export function computeEth30Report(inputs: Eth30ReportInputs): Eth30Report {
  const tickers: Eth30TickerReport[] = [];
  const nowMs = inputs.nowMs ?? Date.now();

  for (const claim of inputs.claims) {
    const orders    = inputs.ordersByTicker.get(claim.ticker) ?? [];
    const events    = inputs.eventsByTicker.get(claim.ticker) ?? [];
    const decisions = inputs.decisionsByTicker.get(claim.ticker) ?? [];
    const entryOrders = orders.filter((o) => o.role === "entry");
    const entry = entryOrders[0] ?? null;
    const sides = [...new Set(entryOrders.map((order) => order.side))];
    const side  = sides.length === 1 ? sides[0]! : null;

    const fills: Eth30FillChunk[] = [];
    let entryContracts = 0, entryCostCents = 0;
    let exitContracts = 0, exitProceedsCents = 0;
    let settlementResult: "yes" | "no" | null = null;
    let settledContracts = 0;
    let totalFeeCents: number | null = 0;   // null = at least one fill missing fee data
    let tickerFillsWithFee = 0;  // count of fill chunks with non-null feeCents
    let tickerTotalFills = 0;    // count of fill chunks total

    for (const ev of events) {
      if (ev.eventType === "entry_fill" && ev.fillPriceCents != null && ev.contractsDelta > 0) {
        const contracts = ev.contractsDelta;
        entryContracts += contracts;
        entryCostCents += ev.fillPriceCents * contracts;
        // Accumulate fees with null propagation: any null makes the total null.
        if (totalFeeCents !== null) {
          totalFeeCents = ev.feeCents != null ? totalFeeCents + ev.feeCents : null;
        }
        if (ev.feeCents != null) tickerFillsWithFee++;
        tickerTotalFills++;
        fills.push({ eventId: ev.id, role: "entry", contracts, priceCents: ev.fillPriceCents,
          costCents: -ev.fillPriceCents * contracts, feeCents: ev.feeCents ?? null,
          occurredAtMs: ev.occurredAtMs, note: ev.note });
      } else if (ev.eventType === "exit_fill" && ev.fillPriceCents != null && ev.contractsDelta < 0) {
        const contracts = -ev.contractsDelta;
        exitContracts += contracts;
        exitProceedsCents += ev.fillPriceCents * contracts;
        if (totalFeeCents !== null) {
          totalFeeCents = ev.feeCents != null ? totalFeeCents + ev.feeCents : null;
        }
        if (ev.feeCents != null) tickerFillsWithFee++;
        tickerTotalFills++;
        fills.push({ eventId: ev.id, role: "exit", contracts, priceCents: ev.fillPriceCents,
          costCents: ev.fillPriceCents * contracts, feeCents: ev.feeCents ?? null,
          occurredAtMs: ev.occurredAtMs, note: ev.note });
      } else if (ev.eventType === "settlement") {
        settlementResult = ev.settlementResult;
        settledContracts += Math.max(0, -ev.contractsDelta);
      }
    }

    // Tickers with no fills carry no fee obligation.
    if (entryContracts === 0) totalFeeCents = 0;

    const openContracts = Math.max(0, entryContracts - exitContracts - settledContracts);
    // Orders are the side-aware quantity authority. Position events predate
    // paired entries and retain a market-level running total, so never infer a
    // paired settlement payout from the first entry side.
    const settlementPayoutCents = settlementResult == null ? 0 : sides.length <= 1
      ? (side === settlementResult ? settledContracts * 100 : 0)
      : Math.max(0, orders.filter((order) => order.side === settlementResult)
        .reduce((sum, order) => sum + (order.role === "entry" ? (order.filledContracts ?? 0) : -(order.filledContracts ?? 0)), 0)) * 100;
    const cashFlowPnlCents = exitProceedsCents + settlementPayoutCents - entryCostCents;
    const firstExec = decisions.find((d) => d.decision === "target_first_executable") ?? null;

    const status: Eth30TickerReport["status"] = entryContracts === 0 ? "no_fill"
      : settlementResult != null ? "settled"
      : openContracts > 0 ? "open" : "closed";
    const isStaleNoFill =
      status === "no_fill" &&
      nowMs - claim.claimedAtMs > STALE_NO_FILL_THRESHOLD_MS;
    const financiallyReconciled = tickerTotalFills > 0
      && tickerFillsWithFee === tickerTotalFills
      && openContracts === 0
      && (status === "closed" || status === "settled");
    const realizedPnlCents = financiallyReconciled ? cashFlowPnlCents : null;
    const netPnlCents = financiallyReconciled && totalFeeCents !== null
      ? cashFlowPnlCents - totalFeeCents : null;

    tickers.push({
      ticker: claim.ticker,
      easternDate: claim.easternDate,
      claimedAtMs: claim.claimedAtMs,
      side,
      sides,
      entryContracts,
      entryCostCents,
      entryAvgPriceCents: entryContracts > 0 ? Math.round(entryCostCents / entryContracts) : null,
      entryPriceBucket: entry?.limitPriceCents != null ? eth30EntryPriceBucket(entry.limitPriceCents) : null,
      exitContracts,
      exitProceedsCents,
      settlementResult,
      settledContracts,
      settlementPayoutCents,
      openContracts,
      cashFlowPnlCents,
      realizedPnlCents,
      totalFeeCents,
      netPnlCents,
      feesIncluded: tickerTotalFills > 0 && tickerFillsWithFee === tickerTotalFills,
      anyFeesCaptured: tickerFillsWithFee > 0,
      financiallyReconciled,
      status,
      isStaleNoFill,
      firstExecutable50AtMs: firstExec?.occurredAtMs ?? null,
      fills,
      decisions,
    });
  }

  tickers.sort((a, b) => b.claimedAtMs - a.claimedAtMs);
  const settled = tickers.filter((t) => t.status === "settled");
  const filledTickers = tickers.filter((t) => t.entryContracts > 0);

  // Aggregate fees with null propagation: null if any filled ticker lacks fee data.
  let summaryFeeCents: number | null = 0;
  for (const t of filledTickers) {
    if (summaryFeeCents === null || t.totalFeeCents === null) {
      summaryFeeCents = null;
    } else {
      summaryFeeCents += t.totalFeeCents;
    }
  }
  const financiallyReconciledTickers = filledTickers.filter((ticker) => ticker.financiallyReconciled);
  const summaryCashFlowPnl = filledTickers.reduce((sum, ticker) => sum + ticker.cashFlowPnlCents, 0);
  const allFilledTickersFinanciallyReconciled = filledTickers.length > 0
    && financiallyReconciledTickers.length === filledTickers.length;
  const summaryRealizedPnl = allFilledTickersFinanciallyReconciled
    ? financiallyReconciledTickers.reduce((sum, ticker) => sum + (ticker.realizedPnlCents ?? 0), 0)
    : null;
  const summaryNetPnl = allFilledTickersFinanciallyReconciled
    ? financiallyReconciledTickers.reduce((sum, ticker) => sum + (ticker.netPnlCents ?? 0), 0)
    : null;

  // feesIncluded is true only when every filled ticker's fill events carry fee data.
  const feesIncluded = filledTickers.length > 0 && summaryFeeCents !== null;
  const priceBandMetrics = (buckets: readonly Eth30EntryPriceBucket[]): Eth30PriceBandMetrics => {
    const trades = tickers.filter((ticker) => ticker.entryContracts > 0 && ticker.entryPriceBucket != null
      && buckets.includes(ticker.entryPriceBucket));
    const reconciled = trades.filter((ticker) => ticker.financiallyReconciled && ticker.netPnlCents != null);
    const principalCents = reconciled.reduce((sum, ticker) => sum + ticker.entryCostCents, 0);
    const feesCents = reconciled.reduce((sum, ticker) => sum + (ticker.totalFeeCents ?? 0), 0);
    const netPnlCents = reconciled.reduce((sum, ticker) => sum + (ticker.netPnlCents ?? 0), 0);
    const targetHits = reconciled.filter((ticker) => ticker.exitContracts > 0).length;
    return {
      trades: trades.length,
      fullyReconciledMarkets: reconciled.length,
      targetHits,
      targetHitRate: reconciled.length > 0 ? targetHits / reconciled.length : null,
      principalCents,
      feesCents,
      netPnlCents,
      roiPercent: principalCents > 0 ? (netPnlCents / principalCents) * 100 : null,
      averagePnlCents: reconciled.length > 0 ? netPnlCents / reconciled.length : null,
    };
  };
  const rejected = new Map<Exclude<Eth30EntryPriceBucket, "23_25" | "26_28">, {
    opportunities: number; rejectionReasons: Record<string, number>;
  }>();
  // Per-ticker lists provide complete loaded history; recentDecisions can also
  // contain current rejected opportunities that have no claim/order row. Merge
  // by durable id so a row present in both sources is counted once.
  const decisionEvidence = new Map<string, Eth30DecisionEventParams>();
  for (const decision of [...inputs.decisionsByTicker.values()].flat()) decisionEvidence.set(decision.id, decision);
  for (const decision of inputs.recentDecisions ?? []) decisionEvidence.set(decision.id, decision);
  for (const decision of decisionEvidence.values()) {
    if (decision.decision !== "entry_rejected_price_band" || decision.priceCents == null) continue;
    const bucket = eth30EntryPriceBucket(decision.priceCents);
    if (bucket === "23_25" || bucket === "26_28") continue;
    const existing = rejected.get(bucket) ?? { opportunities: 0, rejectionReasons: {} };
    existing.opportunities++;
    let reason = "outside_23_28_live_band";
    try {
      const note = decision.note ? JSON.parse(decision.note) as { rejectionReason?: unknown } : null;
      if (typeof note?.rejectionReason === "string") reason = note.rejectionReason;
    } catch { /* Older non-JSON audit notes use the conservative default. */ }
    existing.rejectionReasons[reason] = (existing.rejectionReasons[reason] ?? 0) + 1;
    rejected.set(bucket, existing);
  }

  return {
    strategy: ETH30_STRATEGY_ID,
    entryPolicy: eth30EntryPolicy(),
    source: "eth30_owned_ledgers_only",
    feesIncluded,
    generatedAtMs: nowMs,
    tickers,
    recentDecisions: inputs.recentDecisions ?? [],
    priceBandBreakdown: {
      "23_25": priceBandMetrics(["23_25"]),
      "26_28": priceBandMetrics(["26_28"]),
      "23_28_combined": priceBandMetrics(["23_25", "26_28"]),
      rejectedOpportunities: (["LE_22", "29_30", "GT_30"] as const).map((bucket) => ({
        bucket,
        opportunities: rejected.get(bucket)?.opportunities ?? 0,
        rejectionReasons: rejected.get(bucket)?.rejectionReasons ?? {},
      })),
    },
    summary: {
      claimedTickers: tickers.length,
      tickersWithFills: filledTickers.length,
      staleNoFillTickers: tickers.filter((t) => t.isStaleNoFill).length,
      entryContracts: tickers.reduce((s, t) => s + t.entryContracts, 0),
      entryCostCents: tickers.reduce((s, t) => s + t.entryCostCents, 0),
      exitProceedsCents: tickers.reduce((s, t) => s + t.exitProceedsCents, 0),
      settlementPayoutCents: tickers.reduce((s, t) => s + t.settlementPayoutCents, 0),
      openContracts: tickers.reduce((s, t) => s + t.openContracts, 0),
      cashFlowPnlCents: summaryCashFlowPnl,
      realizedPnlCents: summaryRealizedPnl,
      totalFeeCents: summaryFeeCents,
      netPnlCents: summaryNetPnl,
      settledTickers: settled.length,
      wins: settled.filter((t) => (t.netPnlCents ?? t.realizedPnlCents ?? 0) > 0).length,
      losses: settled.filter((t) => (t.netPnlCents ?? t.realizedPnlCents ?? 0) < 0).length,
    },
  };
}
