/**
 * Resting-order simulation route.
 *
 * GET /api/trade/resting-order-sim?days=N
 *
 * For each zero-fill order in the analytics store (past N days, default 7),
 * this endpoint reviews the recorded in-window BBO ticks and estimates whether
 * a resting GTC limit order placed at T−120 s and cancelled at T−10 s would
 * have had more crossing opportunities than the IOC that was actually submitted.
 *
 * ── What this can and cannot prove ───────────────────────────────────────────
 *  CAN: Quantify how long the price was in-zone during each window, giving an
 *       upper bound on resting-order fill probability.
 *  CANNOT: Confirm actual fills without L2 depth at every tick (only BBO is
 *       recorded per tick). The orderbookCapture module now records L2 at the
 *       moment of order submission; future zero-fills will have better evidence.
 *
 * ── Read-only ─────────────────────────────────────────────────────────────────
 * This route never submits orders, modifies trading state, or reserves budget.
 * It is purely analytical.
 */

import { Router, type IRouter } from "express";
import {
  loadOrdersFromDateRange,
}                                from "../lib/analyticsStore.js";
import {
  loadWindowTicksForTicker,
  type WindowTick,
}                                from "../lib/windowTickStore.js";
import {
  loadWindowTicksSqlForTicker,
}                                from "../lib/tradeStore.js";
import { easternDay }            from "../lib/dailyBudget.js";

const router: IRouter = Router();

// ── Constants mirrored from autoTraderGuards.ts (must stay in sync) ──────────
// OWNER-LOCKED: these mirror the canonical strategy constants in
// src/lib/autoTraderGuards.ts. Do NOT change them here — or there — without
// explicit owner approval and a STRATEGY_VERSION bump (see the owner-lock
// banner in autoTraderGuards.ts). strategyConstants.sync.test.ts fails if
// these drift from the canonical values.
const ALERT_MIN             = 90;   // ¢ inclusive zone floor
const ALERT_MAX             = 95;   // ¢ inclusive zone ceiling
const TIME_ALERT_SECONDS    = 120;  // eval window opens at T−120 s
const CANCEL_BEFORE_SECS    = 10;   // resting order cancelled at T−10 s

// ── Per-order simulation result ───────────────────────────────────────────────

export interface OrderSimResult {
  /** analytics OrderAttemptRecord ID. */
  analyticsId:             string;
  clientOrderId:           string;
  ticker:                  string;
  side:                    "yes" | "no";
  /** Our submitted limit price in outcome-side cents. */
  limitCents:              number;
  /** Wall-clock ms when the IOC order was submitted. */
  submittedAtMs:           number;
  /** Seconds left when our IOC was submitted. */
  submittedSecondsLeft:    number | null;
  /** IOC result. */
  iocFillCount:            number;
  /** Whether we captured an L2 snapshot at submission time. */
  hasL2Snapshot:           boolean;
  /**
   * L2 summary if snapshot available — key evidence for classifying the miss.
   * null when no L2 data was captured (orders before this feature was added).
   */
  l2AtSubmission: {
    depthAtOrBetterDollars:   number;
    depthAtOrBetterContracts: number;
    lowestLevelCents:         number | null;
    lowestLevelDollars:       number | null;
    totalLevels:              number;
    fetchLatencyMs:           number;
    error:                    string | null;
  } | null;
  /**
   * Classification of why the order didn't fill.
   * Requires L2 data; "unknown" when snapshot is absent.
   */
  missClassification:      "no_depth" | "price_too_low" | "partial_depth" | "unknown";
  // ── Resting-order simulation ─────────────────────────────────────────────
  /** Whether tick data is available for this window. */
  hasTicks:                boolean;
  /** Total ticks recorded in the eval window (T−120 to T−0). */
  totalTicksInWindow:      number;
  /** Ticks where price was in zone (72–90¢) and secondsLeft ≥ CANCEL_BEFORE_SECS. */
  inZoneTicksInRestingWindow: number;
  /** Fraction of resting-window ticks that were in-zone. */
  inZoneFraction:          number;
  /**
   * Estimated resting-order fill probability.
   * "high"   — price in zone for >60 s of the resting window.
   * "medium" — price in zone for 15–60 s.
   * "low"    — price in zone for <15 s.
   * "zero"   — price never in zone during resting window.
   * "unknown"— no tick data available.
   */
  restingFillLikelihood:   "high" | "medium" | "low" | "zero" | "unknown";
  /**
   * Estimated fill price had a resting order been placed (= BBO quote when
   * price first entered zone; may differ from actual due to price improvement).
   * Null when not estimable.
   */
  estimatedFillPriceCents: number | null;
  /** Narrative summary for human review. */
  summary:                 string;
}

export interface RestingOrderSimResponse {
  generatedAt:  string;
  daysAnalyzed: number;
  totalOrders:  number;
  zeroFills:    number;
  results:      OrderSimResult[];
  caveats:      string[];
}

// ── Helper ────────────────────────────────────────────────────────────────────

function classifyMiss(
  depthAtOrBetterDollars:   number,
  depthAtOrBetterContracts: number,
  lowestLevelCents:         number | null,
  limitCents:               number,
  hasL2:                    boolean,
): OrderSimResult["missClassification"] {
  if (!hasL2) return "unknown";
  if (depthAtOrBetterDollars === 0 && lowestLevelCents === null) return "no_depth";
  if (depthAtOrBetterDollars === 0 && lowestLevelCents !== null) {
    return lowestLevelCents > limitCents ? "price_too_low" : "no_depth";
  }
  // Some depth at/better than limit existed — IOC should have crossed.
  // If it didn't, the depth was phantom (stale BBO) or sub-minimal.
  if (depthAtOrBetterContracts < 5) return "partial_depth";
  return "no_depth";
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/trade/resting-order-sim", (req, res): void => {
  // Run async logic in a self-contained IIFE so the route handler returns void
  (async () => {
  try {
    const rawDays = parseInt(String(req.query["days"] ?? "7"), 10);
    const days    = isFinite(rawDays) && rawDays > 0 && rawDays <= 90 ? rawDays : 7;

    // Build date list (today back N days, ET calendar)
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86_400_000);
      dates.push(easternDay(d));
    }

    const allOrders = loadOrdersFromDateRange(days);
    const zeroFillOrders = allOrders.filter((o) => o.outcome === "zero_fill");

    // ── Per-ticker tick cache (SQL + NDJSON merged) ────────────────────────
    // SQL is the durable source (survives redeploys). NDJSON is a local-dev
    // fallback. We load SQL first and fall back to NDJSON only if SQL returns
    // nothing for a ticker (e.g. the table doesn't exist yet in dev).
    const tickCache = new Map<string, WindowTick[]>();
    const uniqueTickers = [...new Set(zeroFillOrders.map((o) => o.ticker ?? "").filter(Boolean))];
    await Promise.all(
      uniqueTickers.map(async (ticker) => {
        const sqlTicks  = await loadWindowTicksSqlForTicker(ticker, dates);
        const ndjsonTicks = sqlTicks.length === 0
          ? loadWindowTicksForTicker(ticker, dates)
          : [];
        tickCache.set(ticker, sqlTicks.length > 0 ? sqlTicks : ndjsonTicks);
      }),
    );

    const results: OrderSimResult[] = zeroFillOrders.map((order) => {
      const ticker    = order.ticker      ?? "";
      const limitCents = order.limitPriceCents ?? 0;
      const side      = (order.side ?? "no") as "yes" | "no";

      // Load window ticks for this ticker (pre-fetched above)
      const ticks = tickCache.get(ticker) ?? [];

      // Filter to ticks in the resting window (T−120 to T−10)
      const windowTicks = ticks.filter(
        (t) =>
          t.secondsLeft >= CANCEL_BEFORE_SECS &&
          t.secondsLeft <= TIME_ALERT_SECONDS,
      );

      // In-zone ticks during the resting window
      const inZoneTicks = windowTicks.filter((t) => t.inZone);
      const inZoneSecs  = inZoneTicks.length * 5; // ~5 s between ticks

      const restingFillLikelihood: OrderSimResult["restingFillLikelihood"] =
        windowTicks.length === 0 ? "unknown"
        : inZoneSecs > 60        ? "high"
        : inZoneSecs >= 15       ? "medium"
        : inZoneSecs > 0         ? "low"
        :                          "zero";

      // Estimate fill price = first in-zone tick's relevant BBO
      const firstInZone = inZoneTicks[0];
      let estimatedFillPriceCents: number | null = null;
      if (firstInZone) {
        if (side === "no" && firstInZone.derivedNoAsk != null) {
          estimatedFillPriceCents = firstInZone.derivedNoAsk;
        } else if (side === "yes" && firstInZone.derivedYesAsk != null) {
          estimatedFillPriceCents = firstInZone.derivedYesAsk;
        }
      }

      // L2 snapshot (populated after orderbookCapture was deployed)
      const l2 = (order as unknown as Record<string, unknown>)["l2Snapshot"] as {
        depthAtOrBetterDollars:   number;
        depthAtOrBetterContracts: number;
        lowestLevelCents:         number | null;
        lowestLevelDollars:       number | null;
        totalLevels:              number;
        fetchLatencyMs:           number;
        error:                    string | null;
      } | null | undefined;

      const hasL2      = l2 != null;
      const missClass  = classifyMiss(
        l2?.depthAtOrBetterDollars   ?? 0,
        l2?.depthAtOrBetterContracts ?? 0,
        l2?.lowestLevelCents         ?? null,
        limitCents,
        hasL2,
      );

      // Build narrative summary
      let summary = "";
      if (!hasL2 && windowTicks.length === 0) {
        summary = "No L2 snapshot and no tick data — this order predates both features.";
      } else if (!hasL2) {
        summary = `No L2 snapshot (order predates capture). Ticks: ${windowTicks.length}, in-zone: ~${inZoneSecs}s. ` +
          `Resting likelihood: ${restingFillLikelihood}.`;
      } else {
        const depthStr = l2!.depthAtOrBetterDollars > 0
          ? `$${l2!.depthAtOrBetterDollars.toFixed(2)} notional (~${l2!.depthAtOrBetterContracts} contracts) at/below limit`
          : "zero depth at/below limit";

        if (missClass === "no_depth") {
          summary = `No depth: ${depthStr}. Lowest level: ${l2!.lowestLevelCents ?? "none"}¢. ` +
            `BBO was phantom. Resting order would not have filled either.`;
        } else if (missClass === "price_too_low") {
          summary = `Price mismatch: our limit ${limitCents}¢ < lowest ask ${l2!.lowestLevelCents}¢. ` +
            `Raising limit by ${(l2!.lowestLevelCents ?? limitCents) - limitCents}¢ would cross. ` +
            `Resting likelihood at current limit: ${restingFillLikelihood}.`;
        } else if (missClass === "partial_depth") {
          summary = `Thin depth: ${depthStr} (sub-5 contracts). BBO had a quote but ` +
            `quantity was insufficient for our ${order.requestedContracts ?? "?"}-contract order.`;
        } else {
          summary = `Unknown (no L2 data).`;
        }
      }

      return {
        analyticsId:               order.id ?? "",
        clientOrderId:             order.clientOrderId ?? "",
        ticker,
        side,
        limitCents,
        submittedAtMs:             order.timestampMs ?? 0,
        submittedSecondsLeft:      null, // not currently stored in OrderAttemptRecord
        iocFillCount:              0,
        hasL2Snapshot:             hasL2,
        l2AtSubmission:            hasL2 ? l2! : null,
        missClassification:        missClass,
        hasTicks:                  windowTicks.length > 0,
        totalTicksInWindow:        windowTicks.length,
        inZoneTicksInRestingWindow: inZoneTicks.length,
        inZoneFraction:            windowTicks.length > 0
                                     ? inZoneTicks.length / windowTicks.length
                                     : 0,
        restingFillLikelihood,
        estimatedFillPriceCents,
        summary,
      } satisfies OrderSimResult;
    });

    const response: RestingOrderSimResponse = {
      generatedAt:  new Date().toISOString(),
      daysAnalyzed: days,
      totalOrders:  allOrders.length,
      zeroFills:    zeroFillOrders.length,
      results,
      caveats: [
        "L2 snapshots are only available for orders submitted after orderbookCapture was deployed. " +
          "Historical orders (outcome='zero_fill' before this date) show hasL2Snapshot=false.",
        "Tick data is only available for windows observed after windowTickStore was deployed. " +
          "hasTicks=false means the order predates in-window tick recording.",
        "In-zone tick count uses BBO only. Even with ticks in zone, fills require actual " +
          "L2 depth (a counterparty resting at/better than our limit). BBO can be phantom.",
        "restingFillLikelihood estimates assume depth exists when price is in zone. " +
          "If BBO was phantom (depth=0), likelihood is overstated. Use L2 data to confirm.",
        "inZoneSecs approximation assumes ~5 s between ticks (actual interval varies 3–6 s).",
        "Kalshi TIF values confirmed via live API test (2026-08-01): " +
          "'immediate_or_cancel' (IOC) → 201, order expires; " +
          "'good_till_canceled' (GTC, single-l) → 201, order rests on book, cancel via DELETE /portfolio/events/orders/{id}; " +
          "'fill_or_kill' (FOK) → valid enum (409 = thin book, not invalid param); " +
          "'good_till_cancelled' (double-l) → 400 invalid_parameters — wrong spelling. " +
          "See artifacts/api-server/docs/tif-decision-memo.md for full findings and proposed placeOrder() changes.",
      ],
    };

    res.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
  })();
});

export default router;
