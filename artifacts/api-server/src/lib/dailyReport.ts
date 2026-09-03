/**
 * Daily trading report generator.
 *
 * Builds a human-readable HTML + plain-text report for a given Eastern date,
 * then delivers it via emailTransport. Called by:
 *   - The scheduled 7 AM ET job in index.ts (yesterday's date)
 *   - POST /api/report/daily (manual trigger, any date)
 *
 * Design:
 *   - Pure data-gather + render; never touches trading state.
 *   - Falls back gracefully when SQL is unavailable.
 *   - All errors are logged and returned in the result, never thrown.
 */

import { easternDay } from "./dailyBudget.js";
import { logger } from "./logger.js";
import { sendEmail, type SendResult } from "./emailTransport.js";
import { loadOrdersFromDateRangeAsync } from "./analyticsStore.js";
import { getBudgetForDate } from "./tradeStore.js";
import type { OrderAttemptRecord } from "./analytics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FillRow {
  ticker:       string;
  series:       string;
  asset:        "BTC" | "ETH" | "Other";
  side:         "yes" | "no";
  contracts:    number;
  fillPrice:    number | null; // cents
  amountSpent:  number;        // dollars
  outcome:      "win" | "loss" | "pending";
  grossPnl:     number | null; // dollars
  netPnl:       number | null; // dollars
  windowClose:  string | null;
}

export interface AssetSummary {
  asset:       "BTC" | "ETH" | "Combined";
  fills:       number;
  wins:        number;
  losses:      number;
  pending:     number;
  grossPnl:    number | null;
  netPnl:      number | null;
  winRate:     number | null;
  notional:    number;
}

export interface DailyReportData {
  date:              string;          // YYYY-MM-DD Eastern
  fills:             FillRow[];
  combined:          AssetSummary;
  byAsset:           AssetSummary[];
  budgetSpentCents:  number;
  budgetCapCents:    number;
  budgetRemainingCents: number;
  generatedAt:       string;
  pendingCount:      number;
}

export interface SendDailyReportResult {
  reportData:  DailyReportData;
  sendResult:  SendResult;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BUDGET_CAP_CENTS = Number(process.env["MAX_DAILY_NOTIONAL_CENTS"] ?? 800_000);

function assetOf(series: string): "BTC" | "ETH" | "Other" {
  if (series.startsWith("KXBTC")) return "BTC";
  if (series.startsWith("KXETH")) return "ETH";
  return "Other";
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function dollars(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n).toFixed(2);
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function cents2dollars(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

function buildFillRows(orders: OrderAttemptRecord[], date: string): FillRow[] {
  const fills = orders.filter(
    (o) => {
      const d = easternDay(new Date(o.timestampMs));
      return d === date && (o.outcome === "full_fill" || o.outcome === "partial_fill");
    },
  );

  return fills.map((o) => {
    let outcome: FillRow["outcome"] = "pending";
    if (o.outcomeReconciledAt != null) {
      outcome = o.win === true ? "win" : "loss";
    }

    return {
      ticker:      o.ticker,
      series:      o.series,
      asset:       assetOf(o.series),
      side:        o.side,
      contracts:   o.contracts.value,
      fillPrice:   o.fillPriceCents.value,
      amountSpent: o.notionalDollars.value,
      outcome,
      grossPnl:    o.grossPnlDollars ?? null,
      netPnl:      o.netPnlDollars   ?? null,
      windowClose: o.windowCloseTime ?? null,
    };
  });
}

function buildAssetSummary(rows: FillRow[], asset: "BTC" | "ETH" | "Combined"): AssetSummary {
  const subset = asset === "Combined" ? rows : rows.filter((r) => r.asset === asset);
  const reconciled = subset.filter((r) => r.outcome !== "pending");
  const wins       = reconciled.filter((r) => r.outcome === "win").length;
  const losses     = reconciled.filter((r) => r.outcome === "loss").length;
  const pending    = subset.filter((r) => r.outcome === "pending").length;
  const grossPnl   = reconciled.length > 0
    ? reconciled.reduce((s, r) => s + (r.grossPnl ?? 0), 0)
    : null;
  const netPnl = reconciled.length > 0
    ? reconciled.reduce((s, r) => s + (r.netPnl ?? 0), 0)
    : null;
  const notional = subset.reduce((s, r) => s + r.amountSpent, 0);

  return {
    asset,
    fills:    subset.length,
    wins,
    losses,
    pending,
    grossPnl,
    netPnl,
    winRate:  reconciled.length > 0 ? wins / reconciled.length : null,
    notional,
  };
}

// ── Report builder ────────────────────────────────────────────────────────────

export async function buildDailyReport(date: string): Promise<DailyReportData> {
  // Load orders spanning the target date (load 2 days to be sure we have it)
  const now     = new Date();
  const today   = easternDay(now);
  const isToday = date === today;

  // days=1 if target is today; days=2 if yesterday; days=3 if older to be safe
  const daysDiff = Math.max(
    1,
    Math.ceil((now.getTime() - new Date(date).getTime()) / 86_400_000) + 1,
  );
  const orders = await loadOrdersFromDateRangeAsync(isToday ? 1 : daysDiff);

  const fills   = buildFillRows(orders, date);
  const combined = buildAssetSummary(fills, "Combined");
  const btc      = buildAssetSummary(fills, "BTC");
  const eth      = buildAssetSummary(fills, "ETH");

  // Budget for the target date from SQL
  const budgetSpentCents = await getBudgetForDate(date);

  return {
    date,
    fills,
    combined,
    byAsset:             [btc, eth],
    budgetSpentCents,
    budgetCapCents:      BUDGET_CAP_CENTS,
    budgetRemainingCents: Math.max(0, BUDGET_CAP_CENTS - budgetSpentCents),
    generatedAt:         new Date().toISOString(),
    pendingCount:        fills.filter((r) => r.outcome === "pending").length,
  };
}

// ── Plain-text renderer ───────────────────────────────────────────────────────

function renderText(d: DailyReportData): string {
  const lines: string[] = [];
  lines.push(`Shawshank Investment — Daily Trading Report`);
  lines.push(`Date: ${d.date}   Generated: ${d.generatedAt}`);
  lines.push("=".repeat(60));
  lines.push("");

  // Summary
  lines.push("OVERALL SUMMARY");
  lines.push(`  Fills:         ${d.combined.fills}`);
  lines.push(`  Wins:          ${d.combined.wins}`);
  lines.push(`  Losses:        ${d.combined.losses}`);
  if (d.pendingCount > 0) lines.push(`  Pending:       ${d.pendingCount} (market not yet settled)`);
  lines.push(`  Win rate:      ${d.combined.winRate != null ? pct(d.combined.winRate) : "—"}`);
  lines.push(`  Gross P&L:     ${dollars(d.combined.grossPnl)}`);
  lines.push(`  Net P&L:       ${dollars(d.combined.netPnl)}`);
  lines.push(`  Notional:      ${dollars(d.combined.notional)}`);
  lines.push("");

  // Budget
  lines.push("DAILY BUDGET");
  lines.push(`  Cap:           ${cents2dollars(d.budgetCapCents)}`);
  lines.push(`  Spent:         ${cents2dollars(d.budgetSpentCents)}`);
  lines.push(`  Remaining:     ${cents2dollars(d.budgetRemainingCents)}`);
  lines.push(`  Utilisation:   ${d.budgetCapCents > 0 ? pct(d.budgetSpentCents / d.budgetCapCents) : "—"}`);
  lines.push("");

  // BTC / ETH breakdown
  lines.push("ASSET BREAKDOWN");
  for (const a of d.byAsset) {
    if (a.fills === 0) continue;
    lines.push(`  ${a.asset}`);
    lines.push(`    Fills:       ${a.fills}  |  Wins: ${a.wins}  |  Losses: ${a.losses}${a.pending > 0 ? `  |  Pending: ${a.pending}` : ""}`);
    lines.push(`    Win rate:    ${a.winRate != null ? pct(a.winRate) : "—"}`);
    lines.push(`    Gross P&L:   ${dollars(a.grossPnl)}`);
    lines.push(`    Net P&L:     ${dollars(a.netPnl)}`);
    lines.push(`    Notional:    ${dollars(a.notional)}`);
  }
  lines.push("");

  // Individual fills
  if (d.fills.length > 0) {
    lines.push("FILLS");
    lines.push(`  ${"Ticker".padEnd(24)} ${"Side".padEnd(5)} ${"Qty".padEnd(4)} ${"Price".padEnd(7)} ${"Spent".padEnd(8)} ${"Outcome".padEnd(8)} ${"Gross P&L"}`);
    lines.push("  " + "-".repeat(68));
    for (const f of d.fills) {
      const price = f.fillPrice != null ? `${f.fillPrice}¢` : "—";
      const row = [
        f.ticker.padEnd(24),
        f.side.padEnd(5),
        String(f.contracts).padEnd(4),
        price.padEnd(7),
        dollars(f.amountSpent).padEnd(8),
        f.outcome.padEnd(8),
        dollars(f.grossPnl),
      ].join(" ");
      lines.push("  " + row);
    }
  } else {
    lines.push("No fills recorded for this date.");
  }

  lines.push("");
  if (d.pendingCount > 0) {
    lines.push(`Note: ${d.pendingCount} fill(s) are pending market resolution and not included in P&L.`);
  }
  lines.push("—");
  lines.push("Shawshank Investment automated report. Do not reply.");
  return lines.join("\n");
}

// ── HTML renderer ─────────────────────────────────────────────────────────────

function renderHtml(d: DailyReportData): string {
  const signColor = (n: number | null) =>
    n == null ? "#6b7280" : n >= 0 ? "#16a34a" : "#dc2626";

  const pnlCell = (n: number | null) =>
    `<td style="color:${signColor(n)};text-align:right;padding:4px 8px;">${dollars(n)}</td>`;

  const fillRows = d.fills.map((f) => {
    const badgeColor = f.outcome === "win" ? "#16a34a" : f.outcome === "loss" ? "#dc2626" : "#6b7280";
    return `
      <tr style="border-bottom:1px solid #f3f4f6;">
        <td style="padding:4px 8px;font-family:monospace;font-size:12px;">${f.ticker}</td>
        <td style="padding:4px 8px;text-align:center;">${f.asset}</td>
        <td style="padding:4px 8px;text-align:center;">${f.side.toUpperCase()}</td>
        <td style="padding:4px 8px;text-align:right;">${f.contracts}</td>
        <td style="padding:4px 8px;text-align:right;">${f.fillPrice != null ? f.fillPrice + "¢" : "—"}</td>
        <td style="padding:4px 8px;text-align:right;">${dollars(f.amountSpent)}</td>
        <td style="padding:4px 8px;text-align:center;">
          <span style="background:${badgeColor};color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;">
            ${f.outcome.toUpperCase()}
          </span>
        </td>
        ${pnlCell(f.grossPnl)}
        ${pnlCell(f.netPnl)}
      </tr>`;
  }).join("");

  const assetRows = d.byAsset
    .filter((a) => a.fills > 0)
    .map((a) => `
      <tr style="border-bottom:1px solid #f3f4f6;">
        <td style="padding:4px 8px;font-weight:600;">${a.asset}</td>
        <td style="padding:4px 8px;text-align:right;">${a.fills}</td>
        <td style="padding:4px 8px;text-align:right;">${a.wins}</td>
        <td style="padding:4px 8px;text-align:right;">${a.losses}</td>
        <td style="padding:4px 8px;text-align:right;">${a.winRate != null ? pct(a.winRate) : "—"}</td>
        ${pnlCell(a.grossPnl)}
        ${pnlCell(a.netPnl)}
        <td style="padding:4px 8px;text-align:right;">${dollars(a.notional)}</td>
      </tr>`).join("");

  const utilPct = d.budgetCapCents > 0
    ? ((d.budgetSpentCents / d.budgetCapCents) * 100).toFixed(1) + "%"
    : "—";

  const summaryColor = signColor(d.combined.netPnl);
  const noFillsNote = d.fills.length === 0
    ? `<p style="color:#6b7280;font-style:italic;">No fills were recorded for this date.</p>`
    : "";
  const pendingNote = d.pendingCount > 0
    ? `<p style="color:#92400e;background:#fef3c7;padding:8px 12px;border-radius:4px;font-size:13px;">
         ⏳ ${d.pendingCount} fill(s) are pending market resolution — P&amp;L will update when markets settle.
       </p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Daily Trading Report — ${d.date}</title></head>
<body style="font-family:Arial,sans-serif;color:#111827;background:#f9fafb;padding:24px;margin:0;">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">

    <!-- Header -->
    <div style="background:#1e293b;color:#fff;padding:20px 24px;">
      <div style="font-size:18px;font-weight:700;">Shawshank Investment</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:4px;">Daily Trading Report — ${d.date}</div>
    </div>

    <div style="padding:20px 24px;">

      <!-- Summary cards -->
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;">
        <div style="flex:1;min-width:140px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Net P&amp;L</div>
          <div style="font-size:22px;font-weight:700;color:${summaryColor};">${dollars(d.combined.netPnl)}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Win Rate</div>
          <div style="font-size:22px;font-weight:700;">${d.combined.winRate != null ? pct(d.combined.winRate) : "—"}</div>
          <div style="font-size:12px;color:#64748b;">${d.combined.wins}W / ${d.combined.losses}L${d.pendingCount > 0 ? ` / ${d.pendingCount} pending` : ""}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Budget Used</div>
          <div style="font-size:22px;font-weight:700;">${utilPct}</div>
          <div style="font-size:12px;color:#64748b;">${cents2dollars(d.budgetSpentCents)} of ${cents2dollars(d.budgetCapCents)}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Gross P&amp;L</div>
          <div style="font-size:22px;font-weight:700;color:${signColor(d.combined.grossPnl)}">${dollars(d.combined.grossPnl)}</div>
          <div style="font-size:12px;color:#64748b;">Notional: ${dollars(d.combined.notional)}</div>
        </div>
      </div>

      ${pendingNote}

      <!-- Asset breakdown -->
      ${assetRows ? `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;">BTC / ETH Breakdown</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;">
            <th style="padding:6px 8px;">Asset</th>
            <th style="padding:6px 8px;text-align:right;">Fills</th>
            <th style="padding:6px 8px;text-align:right;">Wins</th>
            <th style="padding:6px 8px;text-align:right;">Losses</th>
            <th style="padding:6px 8px;text-align:right;">Win Rate</th>
            <th style="padding:6px 8px;text-align:right;">Gross P&amp;L</th>
            <th style="padding:6px 8px;text-align:right;">Net P&amp;L</th>
            <th style="padding:6px 8px;text-align:right;">Notional</th>
          </tr>
        </thead>
        <tbody>${assetRows}</tbody>
      </table>` : ""}

      <!-- Fills table -->
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;">Individual Fills</h3>
      ${noFillsNote}
      ${d.fills.length > 0 ? `
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;">
            <th style="padding:6px 8px;">Ticker</th>
            <th style="padding:6px 8px;text-align:center;">Asset</th>
            <th style="padding:6px 8px;text-align:center;">Side</th>
            <th style="padding:6px 8px;text-align:right;">Qty</th>
            <th style="padding:6px 8px;text-align:right;">Fill ¢</th>
            <th style="padding:6px 8px;text-align:right;">Spent</th>
            <th style="padding:6px 8px;text-align:center;">Result</th>
            <th style="padding:6px 8px;text-align:right;">Gross P&amp;L</th>
            <th style="padding:6px 8px;text-align:right;">Net P&amp;L</th>
          </tr>
        </thead>
        <tbody>${fillRows}</tbody>
      </table>` : ""}

    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9;padding:12px 24px;font-size:11px;color:#64748b;text-align:center;">
      Generated ${d.generatedAt} · Shawshank Investment automated report · Do not reply
    </div>
  </div>
</body>
</html>`;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Generate and email the daily trading report for `date` (YYYY-MM-DD Eastern).
 * Defaults to yesterday if omitted.
 * Never throws — all errors are captured in the result.
 */
export async function sendDailyReport(date?: string): Promise<SendDailyReportResult> {
  const targetDate = date ?? (() => {
    const yesterday = new Date(Date.now() - 86_400_000);
    return easternDay(yesterday);
  })();

  logger.info({ date: targetDate }, "dailyReport: generating");

  try {
    const reportData = await buildDailyReport(targetDate);

    const subject = reportData.combined.fills > 0
      ? `Shawshank ${targetDate} — ${reportData.combined.fills} fill(s), Net ${dollars(reportData.combined.netPnl)}`
      : `Shawshank ${targetDate} — No fills`;

    const sendResult = await sendEmail({
      subject,
      text: renderText(reportData),
      html: renderHtml(reportData),
    });

    logger.info(
      { date: targetDate, fills: reportData.combined.fills, sendOk: sendResult.ok },
      "dailyReport: complete",
    );
    return { reportData, sendResult };
  } catch (err) {
    logger.error({ err, date: targetDate }, "dailyReport: unexpected error");
    const empty: DailyReportData = {
      date: targetDate, fills: [], combined: buildAssetSummary([], "Combined"),
      byAsset: [], budgetSpentCents: 0, budgetCapCents: BUDGET_CAP_CENTS,
      budgetRemainingCents: BUDGET_CAP_CENTS, generatedAt: new Date().toISOString(),
      pendingCount: 0,
    };
    return {
      reportData:  empty,
      sendResult:  { ok: false, error: String(err) },
    };
  }
}

/**
 * Compute yesterday's Eastern date string (YYYY-MM-DD).
 */
export function yesterdayEastern(): string {
  const yesterday = new Date(Date.now() - 86_400_000);
  return easternDay(yesterday);
}
