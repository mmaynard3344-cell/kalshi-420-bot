import { captureOrderbook, type OrderbookSnapshot } from "../orderbookCapture.js";
import {
  transitionSweepReclaimClaim,
  updateSweepReclaimClaim,
} from "../tradeStore.js";
import type { EthBigBetExchangeSubmitter } from "./ethBigBetExecutor.js";
import { createEthBigBetKalshiSubmitter } from "./ethBigBetKalshiExchange.js";
import {
  admitSweepReclaimBeforeSubmit,
  transitionSweepReclaimSharedReservation,
} from "./sweepReclaimLiveAdmission.js";
import type { SweepReclaimRuntimeConfig } from "./sweepReclaimV1.js";

export const L_SWEEP_RECLAIM_LIVE_EXECUTION_ENV = "L_SWEEP_RECLAIM_LIVE_EXECUTION_ENABLED" as const;
export const L_SWEEP_RECLAIM_SUPPORTED_ORDER_TYPE = "good_till_canceled" as const;

export type SweepReclaimExecutionOutcome =
  | "disabled"
  | "live_execution_disabled"
  | "config_unresolved"
  | "unsupported_order_type"
  | "invalid_input"
  | "too_late"
  | "price_unavailable"
  | "price_cap_blocked"
  | "correlated_cap_blocked"
  | "correlated_cap_unavailable"
  | "persistence_failed"
  | "routing_unavailable"
  | "submitted"
  | "submission_unknown"
  | "rejected"
  | "persistence_failed_after_submit";

export interface SweepReclaimExecutionInput {
  claimId: string;
  destinationTicker: string;
  exchangeIndex: number;
  destinationCloseTimeMs: number;
  clientOrderId: string;
  config: SweepReclaimRuntimeConfig;
  nowMs?: number;
}

export interface SweepReclaimOrderSize {
  contracts: number;
  maxPrincipalCents: number;
  feeHeadroomCents: number;
  requestedRiskCents: number;
}

type PriceReader = (
  ticker: string,
  side: "yes",
  limitCents: number,
) => Promise<OrderbookSnapshot>;
type ClaimTransition = typeof transitionSweepReclaimClaim;
type ClaimUpdater = typeof updateSweepReclaimClaim;
type ReservationTransition = typeof transitionSweepReclaimSharedReservation;

let priceReaderOverride: PriceReader | null = null;
let exchangeOverride: EthBigBetExchangeSubmitter | null = null;
let claimTransitionOverride: ClaimTransition | null = null;
let claimUpdaterOverride: ClaimUpdater | null = null;
let reservationTransitionOverride: ReservationTransition | null = null;

export function _setSweepReclaimExecutionDepsForTesting(input: {
  priceReader?: PriceReader | null;
  exchange?: EthBigBetExchangeSubmitter | null;
  claimTransition?: ClaimTransition | null;
  claimUpdater?: ClaimUpdater | null;
  reservationTransition?: ReservationTransition | null;
}): void {
  priceReaderOverride = input.priceReader ?? null;
  exchangeOverride = input.exchange ?? null;
  claimTransitionOverride = input.claimTransition ?? null;
  claimUpdaterOverride = input.claimUpdater ?? null;
  reservationTransitionOverride = input.reservationTransition ?? null;
}

function claimTransition(input: Parameters<ClaimTransition>[0]): Promise<boolean> {
  return (claimTransitionOverride ?? transitionSweepReclaimClaim)(input);
}
function updateClaim(input: Parameters<ClaimUpdater>[0]): Promise<boolean> {
  return (claimUpdaterOverride ?? updateSweepReclaimClaim)(input);
}
function transitionReservation(input: Parameters<ReservationTransition>[0]): Promise<boolean> {
  return (reservationTransitionOverride ?? transitionSweepReclaimSharedReservation)(input);
}

export function buildSweepReclaimOrderSize(
  config: SweepReclaimRuntimeConfig,
): SweepReclaimOrderSize | null {
  const stake = config.stakeCents;
  const cap = config.maxEntryPriceCents;
  if (!Number.isSafeInteger(stake) || stake == null || stake <= 0
    || !Number.isInteger(cap) || cap == null || cap < 1 || cap > 99) return null;
  const contracts = Math.floor(stake / cap);
  if (contracts < 1) return null;
  const maxPrincipalCents = contracts * cap;
  const feeHeadroomCents = Math.ceil(0.07 * contracts * cap * (100 - cap) / 100);
  const requestedRiskCents = maxPrincipalCents + feeHeadroomCents;
  if (!Number.isSafeInteger(requestedRiskCents) || requestedRiskCents < 1) return null;
  return { contracts, maxPrincipalCents, feeHeadroomCents, requestedRiskCents };
}

function executableYesPrice(snapshot: OrderbookSnapshot): number | null {
  if (snapshot.error != null) return null;
  const price = snapshot.lowestLevelCents;
  return Number.isInteger(price) && price! >= 1 && price! <= 99 ? price! : null;
}

async function rejectBeforeAdmission(
  input: SweepReclaimExecutionInput,
  reason: string,
  observedYesPriceCents: number | null = null,
): Promise<void> {
  await updateClaim({
    id: input.claimId,
    observedYesPriceCents,
    configuredPriceCapCents: input.config.maxEntryPriceCents,
    admissionOutcome: "blocked",
    rejectionReason: reason,
    lifecycleState: "REJECTED",
  }).catch(() => false);
}

export async function executeSweepReclaimV1(
  input: SweepReclaimExecutionInput,
): Promise<SweepReclaimExecutionOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  const config = input.config;

  if (!config.enabled) return "disabled";
  if (!config.liveExecutionEnabled) return "live_execution_disabled";
  if (!config.activationReady
    || config.maxEntryPriceCents == null
    || config.stakeCents == null
    || config.sharedCorrelatedExposureCapCents == null
    || config.minimumSecondsRemaining == null
    || config.orderType == null) return "config_unresolved";
  if (config.orderType !== L_SWEEP_RECLAIM_SUPPORTED_ORDER_TYPE) return "unsupported_order_type";
  if (!input.claimId
    || !/^KXETH15M-/.test(input.destinationTicker)
    || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0
    || !Number.isSafeInteger(input.destinationCloseTimeMs)
    || !input.clientOrderId
    || !Number.isSafeInteger(nowMs)) return "invalid_input";

  if (input.destinationCloseTimeMs - nowMs < config.minimumSecondsRemaining * 1000) {
    await rejectBeforeAdmission(input, "minimum_time_remaining_blocked");
    return "too_late";
  }

  const size = buildSweepReclaimOrderSize(config);
  if (!size) return "invalid_input";

  const priceReader = priceReaderOverride ?? captureOrderbook;
  const firstBook = await priceReader(
    input.destinationTicker,
    "yes",
    config.maxEntryPriceCents,
  );
  const firstPrice = executableYesPrice(firstBook);
  if (firstPrice == null) {
    await rejectBeforeAdmission(input, "executable_yes_price_unavailable");
    return "price_unavailable";
  }

  const admission = await admitSweepReclaimBeforeSubmit({
    claimId: input.claimId,
    destinationTicker: input.destinationTicker,
    exchangeIndex: input.exchangeIndex,
    clientOrderId: input.clientOrderId,
    requestedContracts: size.contracts,
    requestedRiskCents: size.requestedRiskCents,
    finalYesPriceCents: firstPrice,
    config,
  });
  if (admission.outcome !== "admitted") return admission.outcome;

  const reservationId = admission.reservationId!;
  const secondBook = await priceReader(
    input.destinationTicker,
    "yes",
    config.maxEntryPriceCents,
  );
  const secondPrice = executableYesPrice(secondBook);
  if (secondPrice == null || secondPrice > config.maxEntryPriceCents) {
    await transitionReservation({
      reservationId,
      from: "reserved",
      to: "released",
    }).catch(() => false);
    await claimTransition({
      id: input.claimId,
      from: "ADMITTED",
      to: "REJECTED",
      patch: {
        observedYesPriceCents: secondPrice,
        admissionOutcome: "blocked",
        rejectionReason: secondPrice == null
          ? "final_executable_yes_price_unavailable"
          : "final_price_cap_blocked",
      },
    }).catch(() => false);
    return secondPrice == null ? "price_unavailable" : "price_cap_blocked";
  }

  const submitting = await claimTransition({
    id: input.claimId,
    from: "ADMITTED",
    to: "SUBMITTING",
    patch: {
      observedYesPriceCents: secondPrice,
      configuredPriceCapCents: config.maxEntryPriceCents,
      requestedContracts: size.contracts,
      requestedRiskCents: size.requestedRiskCents,
      clientOrderId: input.clientOrderId,
      rejectionReason: null,
    },
  });
  if (!submitting) {
    await transitionReservation({
      reservationId,
      from: "reserved",
      to: "released",
    }).catch(() => false);
    return "persistence_failed";
  }

  const exchange = exchangeOverride ?? createEthBigBetKalshiSubmitter(input.exchangeIndex);
  if (!exchange) {
    await transitionReservation({ reservationId, from: "reserved", to: "released" }).catch(() => false);
    await claimTransition({
      id: input.claimId,
      from: "SUBMITTING",
      to: "REJECTED",
      patch: { rejectionReason: "exchange_route_unavailable" },
    }).catch(() => false);
    return "routing_unavailable";
  }

  const submitted = await exchange.submit({
    clientOrderId: input.clientOrderId,
    ticker: input.destinationTicker,
    side: "yes",
    contracts: size.contracts,
    limitPriceCents: config.maxEntryPriceCents,
  });

  if (submitted.kind === "accepted") {
    await transitionReservation({
      reservationId,
      from: "reserved",
      to: "submitted",
    }).catch(() => false);
    const written = await claimTransition({
      id: input.claimId,
      from: "SUBMITTING",
      to: "SUBMITTED",
      patch: {
        kalshiOrderId: submitted.exchangeOrderId,
        rejectionReason: null,
      },
    });
    return written ? "submitted" : "persistence_failed_after_submit";
  }

  if (submitted.kind === "rejected") {
    await transitionReservation({
      reservationId,
      from: ["reserved", "submission_unknown"],
      to: "rejected",
    }).catch(() => false);
    await claimTransition({
      id: input.claimId,
      from: "SUBMITTING",
      to: "REJECTED",
      patch: { rejectionReason: submitted.reason || "exchange_rejected" },
    }).catch(() => false);
    return "rejected";
  }

  await transitionReservation({
    reservationId,
    from: "reserved",
    to: "submission_unknown",
  }).catch(() => false);
  const written = await claimTransition({
    id: input.claimId,
    from: "SUBMITTING",
    to: "SUBMISSION_UNKNOWN",
    patch: { rejectionReason: "exchange_submission_unknown" },
  });
  return written ? "submission_unknown" : "persistence_failed_after_submit";
}
