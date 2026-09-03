/**
 * Daily trading report routes.
 *
 * Routes:
 *   POST /api/report/daily          — generate and email the report for yesterday
 *                                     (or a specific ?date=YYYY-MM-DD override)
 *   GET  /api/report/daily/preview  — return the report data as JSON without
 *                                     sending an email (dashboard use)
 *
 * Both routes require the X-Trade-Token header (same auth as trade routes).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.js";
import { sendDailyReport, buildDailyReport, yesterdayEastern } from "../lib/dailyReport.js";
import { buildWeeklyReport, completedEasternWeek, sendWeeklyReport } from "../lib/weeklyReport.js";
import { easternDay } from "../lib/dailyBudget.js";

const router = Router();

// ── Auth (mirrors requireTradeAuth in trade.ts) ───────────────────────────────

const TRADE_API_TOKEN = process.env["TRADE_API_TOKEN"] ?? "";
const DASHBOARD_TRADE_TOKEN = process.env["VITE_TRADE_API_TOKEN"] ?? "";

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!TRADE_API_TOKEN && !DASHBOARD_TRADE_TOKEN) {
    res.status(503).json({ error: "TRADE_API_TOKEN is not configured" });
    return;
  }
  const provided = req.header("x-trade-token") ?? "";
  const matches = (expected: string) => {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  if (!matches(TRADE_API_TOKEN) && !matches(DASHBOARD_TRADE_TOKEN)) {
    logger.warn({ ip: req.ip, path: req.path }, "report: rejected request with invalid token");
    res.status(401).json({ error: "Invalid or missing X-Trade-Token header" });
    return;
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveDate(query: unknown): string | null {
  if (typeof query !== "string" || query === "") return null;
  // Validate YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query)) return null;
  return query;
}

// ── POST /report/daily ───────────────────────────────────────────────────────
// Effective URL: POST /api/report/daily  (app.ts mounts all routes at /api)

router.post("/report/daily", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const date = resolveDate(req.query["date"]) ?? yesterdayEastern();

  logger.info({ date, ip: req.ip }, "report: manual trigger via API");

  try {
    const { reportData, sendResult } = await sendDailyReport(date);

    res.json({
      ok:          sendResult.ok,
      date,
      fills:       reportData.combined.fills,
      netPnl:      reportData.combined.netPnl,
      skipped:     sendResult.skipped ?? false,
      sendInfo:    sendResult.info   ?? null,
      sendError:   sendResult.error  ?? null,
      generatedAt: reportData.generatedAt,
    });
  } catch (err) {
    logger.error({ err }, "report: unexpected error in POST /report/daily");
    res.status(500).json({ error: "Report generation failed", detail: String(err) });
  }
});

// ── GET /report/daily/preview ────────────────────────────────────────────────
// Effective URL: GET /api/report/daily/preview

router.get("/report/daily/preview", requireAuth, async (req: Request, res: Response): Promise<void> => {
  // Allow ?date=today as a convenience alias
  const rawDate = req.query["date"] as string | undefined;
  const date =
    rawDate === "today"
      ? easternDay(new Date())
      : (resolveDate(rawDate) ?? yesterdayEastern());

  logger.info({ date }, "report: preview request");

  try {
    const reportData = await buildDailyReport(date);
    res.json(reportData);
  } catch (err) {
    logger.error({ err }, "report: unexpected error in GET /report/daily/preview");
    res.status(500).json({ error: "Report preview failed", detail: String(err) });
  }
});

// ── Saturday weekly report ─────────────────────────────────────────────────────
// weekEnding is the exclusive Saturday boundary in YYYY-MM-DD Eastern form.

router.get("/report/weekly/preview", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const requested = resolveDate(req.query["weekEnding"]);
  const weekEnding = requested ?? completedEasternWeek().weekEndExclusive;
  try {
    const report = await buildWeeklyReport(weekEnding);
    if (req.query["format"] === "html") {
      res.type("html").send(report.html);
      return;
    }
    res.json(report);
  } catch (err) {
    logger.error({ err, weekEnding }, "report: weekly preview failed");
    res.status(500).json({ error: "Weekly report preview failed", detail: String(err) });
  }
});

router.post("/report/weekly", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const requested = resolveDate(req.query["weekEnding"]);
  const weekEnding = requested ?? completedEasternWeek().weekEndExclusive;
  try {
    const { reportData, sendResult } = await sendWeeklyReport(weekEnding);
    res.json({
      ok: sendResult.ok, skipped: sendResult.skipped ?? false, sendInfo: sendResult.info ?? null,
      sendError: sendResult.error ?? null, weekStart: reportData.weekStart,
      weekEndExclusive: reportData.weekEndExclusive, generatedAt: reportData.generatedAt,
    });
  } catch (err) {
    logger.error({ err, weekEnding }, "report: weekly send failed");
    res.status(500).json({ error: "Weekly report send failed", detail: String(err) });
  }
});

export default router;
