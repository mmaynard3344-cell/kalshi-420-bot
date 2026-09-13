import { buildEthAshleyIntent } from "./ethAshleySignal.js";
import { ethBigBetCapitalRiskCents, ethBigBetContracts, ethBigBetOrderId } from "./ethBigBetLifecycle.js";
import { readApprovedEthBigBetCapitalBase } from "./ethBigBetApprovedCapitalProvider.js";
import { ethDownfadeExecutionStore, initEthDownfadeExecutionStore } from "./ethDownfadeExecutionStore.js";

const now = Date.now();
const ticker = `KXETH15M-PROBE-H-${now}`;
const priorStrike = 4000;
const currentStrike = 3968;
const moveRatio = (currentStrike - priorStrike) / priorStrike;
const declineRatio = -moveRatio;

const intent = buildEthAshleyIntent({
  ticker,
  marketOpenTimeMs: now - 60_000,
  currentStrike,
  priorStrike,
  moveRatio,
  declineRatio,
  ageMs: 60_000,
});

let reservationResult: string = "not_attempted";
let cleanupResult: boolean | null = null;
let capitalAvailable = false;
let requestedRiskCents: number | null = null;
let orderId: string | null = null;

try {
  if (!intent) throw new Error("synthetic_signal_did_not_qualify");
  await initEthDownfadeExecutionStore();
  const capital = await readApprovedEthBigBetCapitalBase(2);
  if (!capital) throw new Error("capital_base_unavailable");
  capitalAvailable = true;
  requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  orderId = ethBigBetOrderId(intent);
  reservationResult = await ethDownfadeExecutionStore.reserveEthBigBetOrder({
    orderId,
    intent,
    requestedContracts: ethBigBetContracts(intent.wagerCents, intent.limitPriceCents),
    capital,
    requestedRiskCents,
    reservedAtMs: now,
  });
  if (reservationResult === "reserved") {
    cleanupResult = await ethDownfadeExecutionStore.acknowledgeEthBigBetOrder({
      orderId,
      status: "rejected",
      exchangeOrderId: null,
      acknowledgedAtMs: Date.now(),
    });
  }
} finally {
  console.log("ETH_FORCED_RESERVATION_PROBE", JSON.stringify({
    service: "H",
    ticker,
    signalQualified: intent != null,
    intent: intent ? { strategy: intent.strategy, side: intent.side, wagerCents: intent.wagerCents, limitPriceCents: intent.limitPriceCents } : null,
    capitalAvailable,
    requestedRiskCents,
    reservationResult,
    cleanupResult,
    orderId,
    exchangeSubmitCalled: false,
  }));
}

if (reservationResult !== "reserved" || cleanupResult !== true) process.exitCode = 2;
