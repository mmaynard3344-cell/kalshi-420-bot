/**
 * SOL_30_50 strategy-only reporting.
 *
 * The report is computed EXCLUSIVELY from the isolated sol30_* ownership
 * ledgers (ticker claims, strategy orders, position events, decision events).
 * Legacy SOL order_attempts / order_fills rows are never consulted, so legacy
 * SOL activity can never be attributed to this strategy.
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
import { SOL30_STRATEGY_ID } from "./sol30_50Rules.js";
import type { Sol30PositionEventParams } from "./sol30FillSync.js";

// ── SOL_30_50 store types (mirrors Eth30 equivalents) ─────────────────────────
// These are defined here pending tradeStore sol30 API additions.

export interface Sol30TickerClaim {
  ticker:               string;
  easternDate:          string;
  claimedAtMs:          number;
  entryClientOrderId:   string;
}

export interface Sol30StrategyOrderParams {
  id:                  string;
  ticker:              string;
  easternDate:         string;
  role:                "entry" | "exit";
  sequenceNumber:      number;
  clientOrderId:       string;
  side:                "yes" | "no";
  limitPriceCents:     number;
  requestedContracts:  number;
}

export interface Sol30StrategyOrder extends Sol30StrategyOrderParams {
  kalshiOrderId:        string | null;
  /** Epoch ms the row was created (null for rows predating this field's mapping). */
  createdAtMs?:         number | null;
  outcome:              "pending" | "full_fill" | "partial_fill" | "zero_fill" | "error" | "cancelled" | "unresolved";
  filledContracts:      number | null;
  averageFillPriceCents: number | null;
  updatedAtMs:          number;
}

export interface Sol30DecisionEventParams {
  id:           string;
  ticker:       string;
  easternDate:  string;
  decision:     string;
  side:         "yes" | "no" | null;
  priceCents:   number | null;
  contracts:    number | null;
  note:         string | null;
  occurredAtMs: number;
}

export interface Sol30FillChunk {
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
export const SOL30_STALE_NO_FILL_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
export interface Sol30TickerReport {
  ticker:               string;

  easternDate:          string;

  claimedAtMs:          number;

  side:                 "yes" | "no" | null;
  /** Outcome-specific entries represented by this market row; paired entries
   * expose both values rather than pretending the first row owns the market. */
  sides:                Array<"yes" | "no">;

  entryContracts:       number;

  entryCostCents:       number;

  entryAvgPriceCents:   number | null;

  exitContracts:        number;

  exitProceedsCents:    number;

  settlementResult:     "yes" | "no" | null;

  settledContracts:     number;

  settlementPayoutCents: number;

  openContracts:        number;

  realizedPnlCents:     number;
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

  status:               "no_fill" | "open" | "closed" | "settled";
  /**
   * True when status is "no_fill" and the claim is older than
   * SOL30_STALE_NO_FILL_THRESHOLD_MS. These are candidates for manual release via the
   * admin endpoint so the ticker can be re-evaluated.
   */

  isStaleNoFill:        boolean;

  firstExecutable50AtMs: number | null;

  fills:                Sol30FillChunk[];

  decisions:            Sol30DecisionEventParams[];

  totalFeeCents:        number | null;
  /** Net P&L after exchange fees: realizedPnlCents − totalFeeCents.
   *  Null when totalFeeCents is null (fees not yet captured for all fills). */
}

export interface Sol30Report {
  strategy:        typeof SOL30_STRATEGY_ID;
  /** Every number below derives ONLY from sol30_* ownership rows. */

  source:          "sol30_owned_ledgers_only";
  /** True once every fill event for every filled ticker carries an exchange fee
   *  from the Kalshi fills API (feeCents non-null). False while any legacy row
   *  without fee data exists — the canonical rebuild will populate them. */

  feesIncluded:    boolean;

  generatedAtMs:   number;

  tickers:         Sol30TickerReport[];

  recentDecisions: Sol30DecisionEventParams[];

  summary: {
    claimedTickers:        number;
    tickersWithFills:      number;
    /** Claimed tickers with no entry fills and a claim age > SOL30_STALE_NO_FILL_THRESHOLD_MS. */
    staleNoFillTickers:    number;
    entryContracts:        number;
    entryCostCents:        number;
    exitProceedsCents:     number;
    settlementPayoutCents: number;
    openContracts:         number;
    realizedPnlCents:      number;
    /** Total exchange fees across all filled tickers. Null when any fill lacks fee data. */
    totalFeeCents:         number | null;
    /** Net P&L after all exchange fees. Null when any fill lacks fee data. */
    netPnlCents:           number | null;
    settledTickers:        number;
    wins:                  number;
    losses:                number;
  };
}

export interface Sol30ReportInputs {
  claims:           Sol30TickerClaim[];
  ordersByTicker:   Map<string, Sol30StrategyOrder[]>;
  eventsByTicker:   Map<string, Sol30PositionEventParams[]>;
  decisionsByTicker: Map<string, Sol30DecisionEventParams[]>;
  recentDecisions?: Sol30DecisionEventParams[];
  nowMs?:           number;
}

/**
 * Pure report builder over already-loaded sol30 rows. Only tickers with a
 * durable claim are reported; events for unclaimed tickers are ignored — a
 * structural guarantee of isolation from legacy SOL orders.
 */
export function computeSol30Report(inputs: Sol30ReportInputs): Sol30Report {
  const tickers: Sol30TickerReport[] = [];
  const nowMs = inputs.nowMs ?? Date.now();

  for (const claim of inputs.claims) {
    const orders    = inputs.ordersByTicker.get(claim.ticker) ?? [];
    const events    = inputs.eventsByTicker.get(claim.ticker) ?? [];
    const decisions = inputs.decisionsByTicker.get(claim.ticker) ?? [];
    const entryOrders = orders.filter((o) => o.role === "entry");
    const entry = entryOrders[0] ?? null;
    const sides = [...new Set(entryOrders.map((order) => order.side))];
    const side  = sides.length === 1 ? sides[0]! : null;

    const fills: Sol30FillChunk[] = [];
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
    const settlementPayoutCents = settlementResult == null ? 0 : sides.length <= 1
      ? (side === settlementResult ? settledContracts * 100 : 0)
      : Math.max(0, orders.filter((order) => order.side === settlementResult)
        .reduce((sum, order) => sum + (order.role === "entry" ? (order.filledContracts ?? 0) : -(order.filledContracts ?? 0)), 0)) * 100;
    const realizedPnlCents = exitProceedsCents + settlementPayoutCents - entryCostCents;
    const netPnlCents = totalFeeCents !== null ? realizedPnlCents - totalFeeCents : null;
    const firstExec = decisions.find((d) => d.decision === "target_first_executable") ?? null;

    const status: Sol30TickerReport["status"] = entryContracts === 0 ? "no_fill"
      : settlementResult != null ? "settled"
      : openContracts > 0 ? "open" : "closed";
    const isStaleNoFill =
      status === "no_fill" &&
      nowMs - claim.claimedAtMs > SOL30_STALE_NO_FILL_THRESHOLD_MS;

    tickers.push({
      ticker: claim.ticker,
      easternDate: claim.easternDate,
      claimedAtMs: claim.claimedAtMs,
      side,
      sides,
      entryContracts,
      entryCostCents,
      entryAvgPriceCents: entryContracts > 0 ? Math.round(entryCostCents / entryContracts) : null,
      exitContracts,
      exitProceedsCents,
      settlementResult,
      settledContracts,
      settlementPayoutCents,
      openContracts,
      realizedPnlCents,
      totalFeeCents,
      netPnlCents,
      feesIncluded: tickerTotalFills > 0 && tickerFillsWithFee === tickerTotalFills,
      anyFeesCaptured: tickerFillsWithFee > 0,
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
  const summaryRealizedPnl = filledTickers.reduce((s, t) => s + t.realizedPnlCents, 0);
  const summaryNetPnl = summaryFeeCents !== null ? summaryRealizedPnl - summaryFeeCents : null;

  // feesIncluded is true only when every filled ticker's fill events carry fee data.
  const feesIncluded = filledTickers.length > 0 && summaryFeeCents !== null;

  return {
    strategy: SOL30_STRATEGY_ID,
    source: "sol30_owned_ledgers_only",
    feesIncluded,
    generatedAtMs: nowMs,
    tickers,
    recentDecisions: inputs.recentDecisions ?? [],
    summary: {
      claimedTickers: tickers.length,
      tickersWithFills: filledTickers.length,
      staleNoFillTickers: tickers.filter((t) => t.isStaleNoFill).length,
      entryContracts: tickers.reduce((s, t) => s + t.entryContracts, 0),
      entryCostCents: tickers.reduce((s, t) => s + t.entryCostCents, 0),
      exitProceedsCents: tickers.reduce((s, t) => s + t.exitProceedsCents, 0),
      settlementPayoutCents: tickers.reduce((s, t) => s + t.settlementPayoutCents, 0),
      openContracts: tickers.reduce((s, t) => s + t.openContracts, 0),
      realizedPnlCents: summaryRealizedPnl,
      totalFeeCents: summaryFeeCents,
      netPnlCents: summaryNetPnl,
      settledTickers: settled.length,
      wins: settled.filter((t) => (t.netPnlCents ?? t.realizedPnlCents) > 0).length,
      losses: settled.filter((t) => (t.netPnlCents ?? t.realizedPnlCents) < 0).length,
    },
  };
}
