import app from "./app.js";
import { logger } from "./lib/logger.js";
import { kalshiSeriesFetch, normalizeMarket } from "./lib/kalshi.js";
import { initTradeStore } from "./lib/tradeStore.js";
import { isProductionRuntime } from "./lib/tradingKillSwitch.js";
import { easternDay } from "./lib/dailyBudget.js";
import { runEthAshV2WhenExplicitlyEnabled } from "./lib/strategies/ethAshV2LiveRunner.js";
import {
  ETH_ASH_V2_DOWN_MIN_RATIO,
  ETH_ASH_V2_DOWN_MAX_RATIO,
  ETH_ASH_V2_UP_MIN_RATIO,
  ETH_ASH_V2_UP_MAX_RATIO,
  ETH_ASH_V2_ENTRY_WINDOW_MS,
  ETH_ASH_V2_LIMIT_PRICE_CENTS,
  ETH_ASH_V2_ORDER_TAG,
  ETH_ASH_V2_WAGER_CENTS,
  buildEthAshV2Intent,
} from "./lib/strategies/ethAshV2Signal.js";
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

async function runForcedIReservationProbe(): Promise<void> {
  const now = Date.now();
  const ticker = `KXETH15M-PROBEI-${now}`;
  const intent = buildEthAshV2Intent({
    ticker,
    marketOpenTimeMs: now - 30_000,
    currentStrike: 992,
    priorStrike: 1000,
    moveRatio: -0.008,
    ageMs: 30_000,
  });
  if (!intent) {
    logger.error({ ticker }, "FORCED_I_RESERVATION_PROBE qualification_failed");
    return;
  }
  const capital = await readApprovedEthBigBetCapitalBase(2);
  if (!capital) {
    logger.error({ ticker }, "FORCED_I_RESERVATION_PROBE capital_base_unavailable");
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
    }, "FORCED_I_RESERVATION_PROBE");
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

    await runEthAshV2WhenExplicitlyEnabled({
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
    logger.warn({ err }, "Ash V2 I market evaluation failed");
  } finally {
    pollInFlight = false;
  }
}

app.listen(port, "0.0.0.0", async () => {
  const role = currentEthServiceRole();
  const enablement = currentEthServiceEnablement();
  logger.info({
    serviceName: "Ash V2",
    serviceLetter: "I",
    serviceRole: role,
    enablement,
    strategy: "optimized_adjacent_strike_mean_reversion",
    downMinPct: ETH_ASH_V2_DOWN_MIN_RATIO * 100,
    downMaxPctExclusive: ETH_ASH_V2_DOWN_MAX_RATIO * 100,
    downSide: "YES",
    upMinPct: ETH_ASH_V2_UP_MIN_RATIO * 100,
    upMaxPctExclusive: ETH_ASH_V2_UP_MAX_RATIO * 100,
    upSide: "NO",
    wagerDollars: ETH_ASH_V2_WAGER_CENTS / 100,
    limitPriceCents: ETH_ASH_V2_LIMIT_PRICE_CENTS,
    entryWindowSeconds: ETH_ASH_V2_ENTRY_WINDOW_MS / 1000,
    orderTag: ETH_ASH_V2_ORDER_TAG,
    productionRuntime: isProductionRuntime(),
    commitSha: process.env["COMMIT_SHA"] ?? "unknown",
  }, "Ash V2 I cold start");

  await initTradeStore();

  if (!isProductionRuntime()) {
    logger.warn("Ash V2 I runner disabled outside production runtime");
    return;
  }
  if (role !== "ash_v2_i" || !enablement.valid || enablement.mode !== "ash_v2_live_requested") {
    logger.warn({ role, enablement }, "Ash V2 I startup fence closed — staged only");
    return;
  }

  await runForcedIReservationProbe();

  void evaluateCurrentMarket();
  const pollTimer = setInterval(() => { void evaluateCurrentMarket(); }, POLL_MS);
  pollTimer.unref?.();

  const accountingSweep = () => {
    void runEthBigBetAccountingSweepSingleFlight().catch((err) =>
      logger.warn({ err }, "Ash V2 I accounting sweep failed"));
  };
  accountingSweep();
  const accountingTimer = setInterval(accountingSweep, ACCOUNTING_SWEEP_MS);
  accountingTimer.unref?.();

  logger.info({ pollMs: POLL_MS }, "Ash V2 I live runner armed");
});

function shutdown(signal: string): void {
  stopping = true;
  logger.info({ signal }, "Ash V2 I shutdown requested");
  process.exit(0);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
