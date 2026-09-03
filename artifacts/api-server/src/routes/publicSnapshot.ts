/**
 * Public read-only snapshot endpoint — Shared Teal.
 *
 * Exposes sanitized aggregate performance data counted from a fixed baseline:
 * August 9 2026, 11:00 AM Eastern (= 2026-08-09T15:00:00Z).
 *
 * Includes:
 *   - Live Kalshi cash balance and total portfolio value
 *   - Aggregate open-position count and exposure (no individual positions)
 *   - Combined + per-asset fills, win/loss, P&L
 *   - Average P&L per settled trade
 *   - Recent settled trades (time + asset + P&L only — no tickers/IDs)
 *
 * Route:
 *   GET /trade/public/snapshot
 */

import { Router } from "express";
import { getWindowAnalytics } from "../lib/analytics.js";
import { loadOrdersFromDateRangeAsync, DASHBOARD_ASSET_PREFIXES } from "../lib/analyticsStore.js";
import { fetchSharedKalshiPositions } from "../lib/kalshiAccountReads.js";
import { fetchKalshiBalanceRead } from "../lib/kalshiBalance.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Fixed baseline: 2026-08-09 11:00 AM Eastern Daylight Time (UTC-4) = 15:00 UTC.
const SHARED_TEAL_CUTOFF_MS = Date.UTC(2026, 7, 9, 15, 0, 0); // 2026-08-09T15:00:00.000Z

type Orders = Awaited<ReturnType<typeof loadOrdersFromDateRangeAsync>>;

function avgPnl(orders: Orders): number | null {
  const resolved = orders.filter(
    (o) => typeof o.netPnlDollars === "number" && o.netPnlDollars !== null,
  );
  if (resolved.length === 0) return null;
  return resolved.reduce((s, o) => s + (o.netPnlDollars as number), 0) / resolved.length;
}

function totalPnl(orders: Orders): number | null {
  const resolved = orders.filter(
    (o) => typeof o.netPnlDollars === "number" && o.netPnlDollars !== null,
  );
  if (resolved.length === 0) return null;
  return resolved.reduce((s, o) => s + (o.netPnlDollars as number), 0);
}

function buildAsset(prefix: string, orders: Orders) {
  const ords   = orders.filter((o) => o.ticker.startsWith(prefix));
  const filled = ords.filter((o) => o.outcome === "full_fill" || o.outcome === "partial_fill");
  const wins   = filled.filter((o) => o.win === true).length;
  const losses = filled.filter((o) => o.win === false).length;
  const pnl    = totalPnl(filled);
  const avg    = avgPnl(filled);
  return {
    submissions:   ords.length,
    fills:         filled.length,
    zeroFills:     ords.filter((o) => o.outcome === "zero_fill").length,
    winsCount:     wins,
    lossesCount:   losses,
    netPnlDollars: pnl  != null ? +pnl.toFixed(2)  : null,
    avgPnlDollars: avg  != null ? +avg.toFixed(2)  : null,
  };
}

router.get("/trade/public/snapshot", async (_req, res) => {
  try {
    // ── Account overview ───────────────────────────────────────────────────────
    let balanceDollars: number | null = null;
    let portfolioValueDollars: number | null = null;
    let openPositionsCount: number | null = null;
    let openExposureDollars: number | null = null;
    let accountDataStale = false;
    try {
      // Both reads flow through the shared quota-aware cache, so concurrent
      // snapshot refreshes (any number of open tabs) coalesce into at most one
      // exchange call per TTL, and a Kalshi 429 serves the last known values
      // marked stale instead of triggering a retry burst.
      const [balRead, positionsRead] = await Promise.all([
        fetchKalshiBalanceRead(),
        fetchSharedKalshiPositions(),
      ]);
      accountDataStale = balRead.stale || positionsRead.stale;
      const balData = balRead.value as { balance?: number; portfolio_value?: number };
      const positionsData = positionsRead.value;
      // Kalshi returns portfolio balances and position exposure in cents.
      if (typeof balData.balance === "number") {
        balanceDollars = +(balData.balance / 100).toFixed(2);
      }
      if (typeof balData.portfolio_value === "number") {
        portfolioValueDollars = +(balData.portfolio_value / 100).toFixed(2);
      }

      const openPositions = (positionsData.market_positions ?? []).filter((position) => {
        const quantity = Number(position["position_fp"]);
        return Number.isFinite(quantity) && quantity !== 0;
      });
      openPositionsCount = openPositions.length;

      const exposureCents = openPositions.reduce((total, position) => {
        const exposure = Number(position["market_exposure_dollars"]);
        return total + (Number.isFinite(exposure) ? exposure * 100 : 0);
      }, 0);
      openExposureDollars = +(exposureCents / 100).toFixed(2);
    } catch (err) {
      logger.warn({ err }, "publicSnapshot: account overview fetch failed — omitting from response");
    }

    // ── Orders since cutoff ────────────────────────────────────────────────────
    // This shared view is cumulative from its fixed Teal baseline, not a
    // rolling-day report. Load durable history first, then apply the cutoff so
    // a day rollover or restart cannot hide valid prior-period trade results.
    const allOrders = await loadOrdersFromDateRangeAsync(0);
    const orders    = allOrders.filter((o) => o.timestampMs >= SHARED_TEAL_CUTOFF_MS);

    // ── Windows since cutoff ───────────────────────────────────────────────────
    const allWindows = getWindowAnalytics().filter(
      (w) =>
        DASHBOARD_ASSET_PREFIXES.some((pfx) => w.ticker.startsWith(pfx)) &&
        w.windowStartMs >= SHARED_TEAL_CUTOFF_MS,
    );

    // ── Per-asset summaries ────────────────────────────────────────────────────
    const btcAsset = buildAsset("KXBTC", orders);
    const ethAsset = buildAsset("KXETH", orders);

    // ── Combined ───────────────────────────────────────────────────────────────
    const filledAll   = orders.filter((o) => o.outcome === "full_fill" || o.outcome === "partial_fill");
    const totalWins   = filledAll.filter((o) => o.win === true).length;
    const totalLosses = filledAll.filter((o) => o.win === false).length;
    const resolvedAll = totalWins + totalLosses;
    const pnlAll      = totalPnl(filledAll);
    const avgAll      = avgPnl(filledAll);

    // ── Recent settled trades (newest first, max 8) ────────────────────────────
    // Strip all identifying info: no ticker, no order ID, no price, no side.
    const recentSettled = filledAll
      .filter((o) => o.win !== null && o.win !== undefined && typeof o.netPnlDollars === "number")
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, 8)
      .map((o) => ({
        timestampMs:   o.timestampMs,
        asset:         o.series.startsWith("KXBTC") ? "BTC" : "ETH",
        outcome:       o.win ? "win" : "loss",
        netPnlDollars: typeof o.netPnlDollars === "number" ? +o.netPnlDollars.toFixed(2) : null,
      }));

    const payload = {
      cutoffIso:     new Date(SHARED_TEAL_CUTOFF_MS).toISOString(),
      generatedAt:   new Date().toISOString(),
      accountDataStale,
      balanceDollars,
      portfolioValueDollars,
      positions: {
        openCount: openPositionsCount,
        openExposureDollars,
      },

      combined: {
        windowsObserved:     allWindows.length,
        windowsEnteringZone: allWindows.filter((w) => w.qualifyingEvaluations > 0).length,
        submissions:         orders.length,
        fills:               filledAll.length,
        zeroFills:           orders.filter((o) => o.outcome === "zero_fill").length,
        fillRatePct:         orders.length > 0
          ? Math.round((filledAll.length / orders.length) * 100)
          : null,
        winsCount:           totalWins,
        lossesCount:         totalLosses,
        winRatePct:          resolvedAll > 0
          ? Math.round((totalWins / resolvedAll) * 100)
          : null,
        netPnlDollars:       pnlAll != null ? +pnlAll.toFixed(2) : null,
        avgPnlDollars:       avgAll != null ? +avgAll.toFixed(2) : null,
      },

      btc:           btcAsset,
      eth:           ethAsset,
      recentTrades:  recentSettled,
    };

    res.json(payload);
  } catch {
    res.status(500).json({ error: "snapshot unavailable" });
  }
});

export default router;
