import app from "./app.js";
import { logger } from "./lib/logger.js";
import { kalshiSeriesFetch, normalizeMarket } from "./lib/kalshi.js";
import { initTradeStore } from "./lib/tradeStore.js";
import { isProductionRuntime } from "./lib/tradingKillSwitch.js";
import { easternDay } from "./lib/dailyBudget.js";
import { runEthAshleyWhenExplicitlyEnabled } from "./lib/strategies/ethAshleyLiveRunner.js";
import {
  ETH_ASHLEY_ENTRY_WINDOW_MS,
  ETH_ASHLEY_LIMIT_PRICE_CENTS,
  ETH_ASHLEY_MAX_DECLINE_RATIO,
  ETH_ASHLEY_MIN_DECLINE_RATIO,
  ETH_ASHLEY_ORDER_TAG,
  ETH_ASHLEY_WAGER_CENTS,
  buildEthAshleyIntent,
} from "./lib/strategies/ethAshleySignal.js";
import { currentEthServiceEnablement } from "./lib/strategies/ethServiceEnablementContract.js";
import { currentEthServiceRole } from "./lib/strategies/ethServiceRole.js";
import { runEthBigBetAccountingSweepSingleFlight } from "./lib/strategies/ethBigBetAccountingSweep.js";
import { ethDownfadeExecutionStore } from "./lib/strategies/ethDownfadeExecutionStore.js";
import { ethBigBetCapitalRiskCents, ethBigBetContracts, ethBigBetOrderId } from "./lib/strategies/ethBigBetLifecycle.js";
import { readApprovedEthBigBetCapitalBase } from "./lib/strategies/ethBigBetApprovedCapitalProvider.js";

const POLL_MS = 2_000;
const ACCOUNTING_SWEEP_MS = 5 * 60_000;
let pollInFlight = false;
let stopping = false;

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT value: ${rawPort}`);

async function runForcedHReservationProbe(): Promise<void> {
  const now = Date.now();
  const ticker = `KXETH15M-PROBEH-${now}`;
  const intent = buildEthAshleyIntent({
    ticker,
    marketOpenTimeMs: now - 30_000,
    currentStrike: 992,
    priorStrike: 1000,
    moveRatio: -0.008,
    declineRatio: 0.008,
    ageMs: 30_000,
  });
  if (!intent) {
    logger.error({ ticker }, "FORCED_H_RESERVATION_PROBE qualification_failed");
    return;
  }
  const capital = await readApprovedEthBigBetCapitalBase(2);
  if (!capital) {
    logger.error({ ticker }, "FORCED_H_RESERVATION_PROBE capital_base_unavailable");
    return;
  }
  const requestedContracts = ethBigBetContracts(intent.wagerCents, intent.limitPriceCents);
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  const orderId = ethBigBetOrderId(intent);
  let reservation: "reserved" | "capital_blocked" | "reservation_failed" = "reservation_failed";
  let cleanupAcknowledged = false;
  let remainingUnresolvedSyntheticRow = false;
  try {
    reservation = await ethDownfadeExecutionStore.reserveEthBigBetOrder({
      orderId,
      intent,
      requestedContracts,
      requestedRiskCents,
      capital,
      reservedAtMs: Date.now(),
    });
  } finally {
    if (reservation === "reserved") {
      cleanupAcknowledged = await ethDownfadeExecutionStore.acknowledgeEthBigBetOrder({
        orderId,
        exchangeOrderId: null,
        status: "rejected",
        acknowledgedAtMs: Date.now(),
      });
    }
    const unresolved = await ethDownfadeExecutionStore.listUnresolvedEthBigBetOrderIds(intent.strategy);
    remainingUnresolvedSyntheticRow = unresolved.includes(orderId);
    logger.info({
      ticker,
      orderId,
      qualified: true,
      intent: {
        strategy: intent.strategy,
        orderTag: intent.orderTag,
        side: intent.side,
        wagerCents: intent.wagerCents,
        limitPriceCents: intent.limitPriceCents,
      },
      capital: {
        availableBalanceCents: capital.availableBalanceCents,
        martingaleReserveCents: capital.martingaleReserveCents,
        safetyReserveCents: capital.safetyReserveCents,
        otherBigBetReservedCents: capital.otherBigBetReservedCents,
      },
      requestedContracts,
      requestedRiskCents,
      reservation,
      cleanupAcknowledged,
      remainingUnresolvedSyntheticRow,
      exchangeSubmitCalled: false,
    }, "FORCED_H_RESERVATION_PROBE");
  }
}

async function evaluateCurrentMarket(): Promise<void> {
  if (pollInFlight || stopping) return;
  pollInFlight = true;
  try {
    const raw = await kalshiSeriesFetch("KXETH15M", { forceFresh: true });
    if (!raw) return;
    const market = normalizeMarket(raw);
    const ticker = typeof market["ticker"] === "string" ? market["ticker"] : null;
    const openTime = typeof market["open_time"] === "string" ? market["open_time"] : null;
    const openTimeMs = openTime ? Date.parse(openTime) : NaN;
    const status = typeof market["status"] === "string" ? market["status"] : null;
    const exchangeIndex = typeof market["exchange_index"] === "number" && Number.isInteger(market["exchange_index"])
      ? market["exchange_index"] as number : null;
    const floorStrike = typeof market["floor_strike"] === "number" ? market["floor_strike"] as number : null;
    if (!ticker || !/^KXETH15M-/.test(ticker) || !Number.isFinite(openTimeMs) || status !== "open") return;

    await runEthAshleyWhenExplicitlyEnabled({
      market: {
        ticker,
        easternDate: easternDay(new Date(openTimeMs)),
        observedAtMs: Date.now(),
        floorStrike,
        openTimeMs,
      },
      exchangeIndex,
    });
  } catch (err) {
    logger.warn({ err }, "Ashley H market evaluation failed");
  } finally {
    pollInFlight = false;
  }
}

app.listen(port, "0.0.0.0", async () => {
  const role = currentEthServiceRole();
  const enablement = currentEthServiceEnablement();
  logger.info({
    serviceName: "Ashley",
    serviceLetter: "H",
    serviceRole: role,
    enablement,
    strategy: "adjacent_strike_down_mean_reversion",
    minDeclinePct: ETH_ASHLEY_MIN_DECLINE_RATIO * 100,
    maxDeclinePctExclusive: ETH_ASHLEY_MAX_DECLINE_RATIO * 100,
    side: "YES",
    wagerDollars: ETH_ASHLEY_WAGER_CENTS / 100,
    limitPriceCents: ETH_ASHLEY_LIMIT_PRICE_CENTS,
    entryWindowSeconds: ETH_ASHLEY_ENTRY_WINDOW_MS / 1000,
    orderTag: ETH_ASHLEY_ORDER_TAG,
    productionRuntime: isProductionRuntime(),
    commitSha: process.env["COMMIT_SHA"] ?? "unknown",
  }, "Ashley H cold start");

  await initTradeStore();

  if (!isProductionRuntime()) {
    logger.warn("Ashley H live runner disabled outside production runtime");
    return;
  }
  if (role !== "downfade_h" || !enablement.valid || enablement.mode !== "downfade_live_requested") {
    logger.error({ role, enablement }, "Ashley H startup fence closed — live runner not armed");
    return;
  }

  await runForcedHReservationProbe();

  void evaluateCurrentMarket();
  const pollTimer = setInterval(() => { void evaluateCurrentMarket(); }, POLL_MS);
  pollTimer.unref?.();

  const accountingSweep = () => {
    void runEthBigBetAccountingSweepSingleFlight().catch((err) =>
      logger.warn({ err }, "Ashley H accounting sweep failed"));
  };
  accountingSweep();
  const accountingTimer = setInterval(accountingSweep, ACCOUNTING_SWEEP_MS);
  accountingTimer.unref?.();

  logger.info({ pollMs: POLL_MS }, "Ashley H live runner armed");
});

function shutdown(signal: string): void {
  stopping = true;
  logger.info({ signal }, "Ashley H shutdown requested");
  process.exit(0);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
