/**
 * Read-only Saturday report for Shawshank Investments.
 * Financial totals are derived from durable child fill chunks. Any parent-only
 * order is retained as preliminary rather than silently added to final figures.
 */
import { sendEmail, type SendResult } from "./emailTransport.js";
import {
  getVerifiedPnlBySeries,
  getWeeklyExecutionEvidence,
  isStorageHealthy,
  loadGuardCountsFromSql,
  loadProtectiveExitAttemptsForRange,
} from "./tradeStore.js";
import { completedEasternWeek, easternMidnightMs, weekStartForEnd } from "./weeklyReportCalendar.js";

export interface WeeklyReportData {
  recipient: "Mr. Teal";
  weekStart: string;
  weekEndExclusive: string;
  generatedAt: string;
  execution: Awaited<ReturnType<typeof getWeeklyExecutionEvidence>>;
  realized: Awaited<ReturnType<typeof getVerifiedPnlBySeries>>["combined"];
  lossPrevention: {
    protectiveExitAvailable: boolean;
    totalAuditRows: number;
    submitted: number;
    completedWithFill: number;
    bypassed: number;
    unresolved: number;
    outcomes: Record<string, number>;
    guardCountsAvailable: boolean;
    guardCounts: Record<string, number>;
  };
  researchNotice: string;
  text: string;
  html: string;
}

export interface SendWeeklyReportResult {
  reportData: WeeklyReportData;
  sendResult: SendResult;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day! + days));
  return value.toISOString().slice(0, 10);
}

export { completedEasternWeek, easternMidnightMs } from "./weeklyReportCalendar.js";

function money(value: number | null): string {
  if (value === null) return "Unavailable";
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function countOutcomes(rows: Array<{ outcome: string; postInitiated: boolean; fillQuantity?: number | null }>) {
  const outcomes: Record<string, number> = {};
  for (const row of rows) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
  const bypassed = rows.filter((row) => ["not_armed", "gap_below_floor"].includes(row.outcome)).length;
  const unresolved = rows.filter((row) => ["reserved", "post_started", "post_unknown"].includes(row.outcome)).length;
  return {
    totalAuditRows: rows.length,
    submitted: rows.filter((row) => row.postInitiated).length,
    completedWithFill: rows.filter((row) => (row.fillQuantity ?? 0) > 0).length,
    bypassed,
    unresolved,
    outcomes,
  };
}

function renderText(data: Omit<WeeklyReportData, "text" | "html">): string {
  const e = data.execution;
  const p = data.realized;
  const g = data.lossPrevention;
  return [
    "Shawshank Investments — Weekly Report",
    `Prepared for Mr. Teal | Week: ${data.weekStart} through ${data.weekEndExclusive} (Eastern, end exclusive)`,
    "",
    "EXECUTIVE SUMMARY",
    "This report separates exchange-ledger-confirmed figures from preliminary data. No preliminary P&L is presented as final.",
    "",
    "ACTUAL EXECUTION EXPOSURE",
    e.available
      ? `Ledger-verified: ${e.filledOrderCount} executed order(s); ${e.ledgerBackedOrderCount} backed by canonical child fills; ${e.ledgerFillCount} fill chunk(s).`
      : "Unavailable: durable execution ledger could not be queried.",
    `Verified filled notional: ${money(e.filledNotionalDollars)}`,
    `Verified fees: ${money(e.feeDollars)}`,
    `Verified cash outlay: ${e.filledNotionalDollars === null || e.feeDollars === null ? "Unavailable" : money(e.filledNotionalDollars + e.feeDollars)}`,
    `Verified filled contracts: ${e.filledContracts ?? "Unavailable"}`,
    e.preliminaryOrderCount > 0
      ? `Preliminary (not included above): ${e.preliminaryOrderCount} response-confirmed order(s), notional ${money(e.preliminaryNotionalDollars)}, fees ${money(e.preliminaryFeeDollars)}.`
      : "No parent-only preliminary fills were found.",
    "",
    "EXCHANGE-RECONCILED RESULTS",
    `Settled entries: ${p.settledFillCount}; awaiting settlement or ledger verification: ${p.pendingVerificationCount}; reconciliation failures: ${p.unverifiedFillCount}.`,
    `Verified realized net P&L: ${money(p.realizedNetPnlDollars)}${p.realizedNetPnlDollars === null ? " (withheld until every settled entry has canonical fill evidence)" : ""}`,
    "",
    "PREVENTATIVE-LOSS OVERSIGHT",
    g.protectiveExitAvailable
      ? `Live 80¢ protective-exit audit: ${g.totalAuditRows} record(s), ${g.submitted} order submission(s), ${g.completedWithFill} fill(s), ${g.bypassed} bypass/audit-only condition(s), ${g.unresolved} unresolved attempt(s).`
      : "Live protective-exit audit: unavailable.",
    g.guardCountsAvailable
      ? `Pre-entry safeguard observations: ${Object.values(g.guardCounts).reduce((total, value) => total + value, 0)} durable guard outcomes across the week.`
      : "Pre-entry safeguard observations: unavailable.",
    "Guard counts describe evaluated conditions, not realised savings or avoided losses.",
    "",
    "RESEARCH STATUS",
    data.researchNotice,
    "",
    "NEXT WEEK OPERATING CHECKLIST",
    "• Review unresolved settlement and ledger-verification items before relying on P&L.",
    "• Review protective-exit audit bypasses and unresolved attempts as operational evidence.",
    "• Continue prospective research without joining outcomes to sealed studies or changing live rules.",
  ].join("\n");
}

function renderHtml(data: Omit<WeeklyReportData, "text" | "html">): string {
  const text = renderText(data).split("\n").map((line) => line ? `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : "<br>").join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shawshank Weekly Report</title></head>
  <body style="margin:0;background:#f5f7fb;font:15px Arial,sans-serif;color:#172033"><main style="max-width:760px;margin:32px auto;background:#fff;padding:36px;border-radius:12px;box-shadow:0 2px 10px #0001">
  <h1 style="margin-top:0">Shawshank Investments — Weekly Report</h1><h2 style="font-size:17px;color:#4b5563">Prepared for Mr. Teal</h2>
  <div style="line-height:1.5">${text}</div><hr><small>Generated ${data.generatedAt}. Financial totals use the durable child-fill ledger; unavailable data is not estimated.</small>
  </main></body></html>`;
}

export async function buildWeeklyReport(weekEndExclusive?: string): Promise<WeeklyReportData> {
  const interval = weekEndExclusive
    ? { weekStart: weekStartForEnd(weekEndExclusive), weekEndExclusive }
    : completedEasternWeek();
  const lastCoveredDate = addDays(interval.weekEndExclusive, -1);
  const [execution, verified, exits] = await Promise.all([
    getWeeklyExecutionEvidence(interval.weekStart, lastCoveredDate),
    getVerifiedPnlBySeries(interval.weekStart, lastCoveredDate),
    loadProtectiveExitAttemptsForRange(easternMidnightMs(interval.weekStart), easternMidnightMs(interval.weekEndExclusive)),
  ]);
  const guardCounts: Record<string, number> = {};
  const guardsAvailable = isStorageHealthy();
  if (guardsAvailable) {
    for (let day = interval.weekStart; day < interval.weekEndExclusive; day = addDays(day, 1)) {
      const bySeries = await loadGuardCountsFromSql(day);
      for (const counts of bySeries.values()) {
        for (const [key, value] of Object.entries(counts)) guardCounts[key] = (guardCounts[key] ?? 0) + value;
      }
    }
  }
  const prevention = {
    protectiveExitAvailable: exits !== null,
    ...countOutcomes(exits ?? []),
    guardCountsAvailable: guardsAvailable,
    guardCounts,
  };
  const base = {
    recipient: "Mr. Teal" as const, ...interval, generatedAt: new Date().toISOString(), execution,
    realized: verified.combined, lossPrevention: prevention,
    researchNotice: "Fold the Ace and related pre-entry research remain outcome-blind and research-only. This report records coverage and safeguards, not a live veto, causal conclusion, or prevented-loss claim.",
  };
  return { ...base, text: renderText(base), html: renderHtml(base) };
}

export async function sendWeeklyReport(weekEndExclusive?: string): Promise<SendWeeklyReportResult> {
  const reportData = await buildWeeklyReport(weekEndExclusive);
  const subject = `Shawshank weekly report for Mr. Teal — week ending ${reportData.weekEndExclusive}`;
  return { reportData, sendResult: await sendEmail({ subject, text: reportData.text, html: reportData.html }) };
}