/**
 * CSV export helpers — minimal RFC-4180 serializer, no external deps.
 * All functions are read-only wrappers around analytics getters.
 */

import { getOrderAttempts, getWindowAnalytics, getDailySummary } from "./analytics.js";
import type { EthMartingaleLedgerExportRow } from "./tradeStore.js";

// ── Core serializer ───────────────────────────────────────────────────────────

/**
 * Serialise a table to RFC-4180 CSV.
 * Values containing commas, double-quotes, or newlines are quoted;
 * internal double-quotes are escaped by doubling.
 * Lines are separated by CRLF per spec.
 */
export function recordsToCsv(headers: string[], rows: unknown[][]): string {
  const escape = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(escape).join(","));
  return lines.join("\r\n");
}

function timestampInEasternTime(timestampMs: number | null): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestampMs)).replace(",", "");
}

/** CSV projection for the isolated, durable ETH martingale ledger. */
export function ethMartingaleLedgerToCSV(rows: EthMartingaleLedgerExportRow[]): string {
  const headers = [
    "entered_et", "ticker", "eastern_date", "martingale_step", "side", "outcome",
    "filled_contracts", "fill_price_cents", "cost_dollars", "fee_dollars",
    "settlement_result", "settled_et", "pnl_status", "net_pnl_dollars",
  ];
  return recordsToCsv(headers, rows.map((row) => [
    timestampInEasternTime(row.createdAtMs), row.ticker, row.easternDate, row.martingaleStep,
    row.side, row.outcome, row.filledContracts, row.actualFillPriceCents,
    row.actualNotionalDollars, row.actualFeeDollars, row.settlementResult,
    row.settlementResult === "yes" || row.settlementResult === "no"
      ? timestampInEasternTime(row.settledAtMs ?? null) : "",
    row.pnlStatus, row.netPnlDollars,
  ]));
}

// ── Formatted exports ─────────────────────────────────────────────────────────

export function ordersToCSV(): string {
  const orders = getOrderAttempts(undefined, 1_000);
  const headers = [
    "id",
    "timestampMs",
    "ticker",
    "series",
    "side",
    "attemptNumber",
    "source",
    "triggerPriceCents",
    "limitPriceCents",
    "requestedContracts",
    "outcome",
    "fillPriceCents",
    "fillPriceSource",
    "contracts",
    "contractsSource",
    "notionalDollars",
    "feeDollars",
    "roundTripMs",
    "orderId",
    "reconciled",
  ];
  const rows = orders.map((o) => [
    o.id,
    o.timestampMs,
    o.ticker,
    o.series,
    o.side,
    o.attemptNumber,
    o.source,
    o.triggerPriceCents,
    o.limitPriceCents,
    o.requestedContracts,
    o.outcome,
    o.fillPriceCents.value ?? "",
    o.fillPriceCents.source,
    o.contracts.value,
    o.contracts.source,
    o.notionalDollars.value,
    o.feeDollars.value,
    o.roundTripMs ?? "",
    o.orderId ?? "",
    o.reconciled,
  ]);
  return recordsToCsv(headers, rows);
}

export function windowsToCSV(): string {
  const windows = getWindowAnalytics();
  const headers = [
    "ticker",
    "series",
    "windowStartMs",
    "windowClose",
    "result",
    "qualifyingEvaluations",
    "submittedOrders",
    "zeroFills",
    "partialFills",
    "fullFills",
    "attemptNumberThatFilled",
    "actualFilledContracts",
    "actualFillPriceCents",
    "totalSpendDollars",
    "totalFeesDollars",
  ];
  const rows = windows.map((w) => [
    w.ticker,
    w.series,
    w.windowStartMs,
    w.windowClose ?? "",
    w.result,
    w.qualifyingEvaluations,
    w.submittedOrders,
    w.zeroFills,
    w.partialFills,
    w.fullFills,
    w.attemptNumberThatFilled ?? "",
    w.actualFilledContracts,
    w.actualFillPriceCents ?? "",
    w.totalSpendDollars,
    w.totalFeesDollars,
  ]);
  return recordsToCsv(headers, rows);
}

export function dailySummaryToCSV(): string {
  const summary = getDailySummary();
  const headers = [
    "date",
    "series",
    "windowsObserved",
    "windowsEnteringZone",
    "orderSubmissions",
    "successfulFills",
    "partialFills",
    "zeroFills",
    "fillRateByOrderAttempt",
    "fillRateByQualifyingWindow",
    "avgAttemptsPerFilledTicker",
    "medianAttemptsPerFilledTicker",
    "maxAttemptsOnOneTicker",
    "filledNotionalDollars",
    "feesDollars",
    "avgLimitPriceCents",
    "avgActualFillPriceCents",
    "avgPriceImprovementCents",
    "restTriggeredOrders",
    "websocketTriggeredOrders",
  ];
  const rows = [summary.btc, summary.eth, summary.combined].map((s) => [
    summary.date,
    s.series,
    s.windowsObserved,
    s.windowsEnteringZone,
    s.orderSubmissions,
    s.successfulFills,
    s.partialFills,
    s.zeroFills,
    s.fillRateByOrderAttempt ?? "",
    s.fillRateByQualifyingWindow ?? "",
    s.avgAttemptsPerFilledTicker ?? "",
    s.medianAttemptsPerFilledTicker ?? "",
    s.maxAttemptsOnOneTicker,
    s.filledNotionalDollars,
    s.feesDollars,
    s.avgLimitPriceCents ?? "",
    s.avgActualFillPriceCents ?? "",
    s.avgPriceImprovementCents ?? "",
    s.restTriggeredOrders,
    s.websocketTriggeredOrders,
  ]);
  return recordsToCsv(headers, rows);
}
