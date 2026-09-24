import { updateSweepReclaimClaim } from "../tradeStore.js";
import {
  PostgresEthLongReversalStore,
  acquireEthLongReversalExposure,
  type EthLongReversalStore,
} from "./ethLongReversalExposure.js";
import type { SweepReclaimRuntimeConfig } from "./sweepReclaimV1.js";

export type SweepReclaimPreSubmitOutcome =
  | "admitted"
  | "disabled"
  | "config_unresolved"
  | "invalid_input"
  | "price_cap_blocked"
  | "correlated_cap_blocked"
  | "correlated_cap_unavailable"
  | "persistence_failed";

export interface SweepReclaimPreSubmitInput {
  claimId: string;
  destinationTicker: string;
  exchangeIndex: number;
  clientOrderId: string;
  requestedContracts: number;
  requestedRiskCents: number;
  finalYesPriceCents: number;
  config: SweepReclaimRuntimeConfig;
}

export interface SweepReclaimPreSubmitResult {
  outcome: SweepReclaimPreSubmitOutcome;
  reservationId: string | null;
  currentExposureCents: number | null;
  postTradeExposureCents: number | null;
  capCents: number | null;
}

type ClaimUpdater = typeof updateSweepReclaimClaim;

let storeOverride: EthLongReversalStore | null = null;
let claimUpdaterOverride: ClaimUpdater | null = null;

export function _setSweepReclaimAdmissionDepsForTesting(input: {
  store?: EthLongReversalStore | null;
  claimUpdater?: ClaimUpdater | null;
}): void {
  storeOverride = input.store ?? null;
  claimUpdaterOverride = input.claimUpdater ?? null;
}

async function productionStore(): Promise<EthLongReversalStore> {
  if (storeOverride) return storeOverride;
  const mod = await import("@workspace/db");
  return new PostgresEthLongReversalStore(mod.db as any);
}

async function updateClaim(input: Parameters<ClaimUpdater>[0]): Promise<boolean> {
  return (claimUpdaterOverride ?? updateSweepReclaimClaim)(input);
}

/**
 * Final L gate immediately before any future exchange submission.
 *
 * This function never submits an order. It requires:
 *   1) explicit live enablement + complete literal config;
 *   2) a final executable YES price at/below the hard cap;
 *   3) durable claim evidence update;
 *   4) successful shared E/H/I-downside/L correlated exposure reservation.
 *
 * Any failure is fail-closed. If the final durable ADMITTED write fails after
 * the correlated reservation is created, the reservation is released before
 * returning persistence_failed.
 */
export async function admitSweepReclaimBeforeSubmit(
  input: SweepReclaimPreSubmitInput,
): Promise<SweepReclaimPreSubmitResult> {
  const empty = (
    outcome: SweepReclaimPreSubmitOutcome,
    capCents: number | null = input.config.sharedCorrelatedExposureCapCents,
  ): SweepReclaimPreSubmitResult => ({
    outcome,
    reservationId: null,
    currentExposureCents: null,
    postTradeExposureCents: null,
    capCents,
  });

  if (!input.config.enabled) return empty("disabled");
  if (!input.config.activationReady
    || input.config.maxEntryPriceCents == null
    || input.config.sharedCorrelatedExposureCapCents == null) {
    return empty("config_unresolved");
  }
  if (!input.claimId
    || !/^KXETH15M-/.test(input.destinationTicker)
    || !Number.isInteger(input.exchangeIndex) || input.exchangeIndex < 0
    || !input.clientOrderId
    || !Number.isInteger(input.requestedContracts) || input.requestedContracts < 1
    || !Number.isSafeInteger(input.requestedRiskCents) || input.requestedRiskCents < 1
    || !Number.isInteger(input.finalYesPriceCents) || input.finalYesPriceCents < 1 || input.finalYesPriceCents > 99) {
    return empty("invalid_input");
  }

  if (input.finalYesPriceCents > input.config.maxEntryPriceCents) {
    await updateClaim({
      id: input.claimId,
      observedYesPriceCents: input.finalYesPriceCents,
      configuredPriceCapCents: input.config.maxEntryPriceCents,
      requestedContracts: input.requestedContracts,
      requestedRiskCents: input.requestedRiskCents,
      admissionOutcome: "blocked",
      rejectionReason: "price_cap_blocked",
      lifecycleState: "REJECTED",
    }).catch(() => false);
    return empty("price_cap_blocked");
  }

  const pendingWritten = await updateClaim({
    id: input.claimId,
    observedYesPriceCents: input.finalYesPriceCents,
    configuredPriceCapCents: input.config.maxEntryPriceCents,
    requestedContracts: input.requestedContracts,
    requestedRiskCents: input.requestedRiskCents,
    proposedExposureCents: input.requestedRiskCents,
    sharedExposureCapCents: input.config.sharedCorrelatedExposureCapCents,
    admissionOutcome: "pending",
    rejectionReason: null,
    lifecycleState: "ADMISSION_PENDING",
    clientOrderId: input.clientOrderId,
  });
  if (!pendingWritten) return empty("persistence_failed");

  const store = await productionStore();
  const reservationId = `long-reversal:L:${input.claimId}`;
  const admission = await acquireEthLongReversalExposure({
    id: reservationId,
    service: "L",
    strategy: "SWEEP_RECLAIM_V1",
    ticker: input.destinationTicker,
    side: "yes",
    clientOrderId: input.clientOrderId,
    sourceOrderId: input.claimId,
    exchangeIndex: input.exchangeIndex,
    requestedRiskCents: input.requestedRiskCents,
    capCents: input.config.sharedCorrelatedExposureCapCents,
    store,
  });

  if (!admission.allowed) {
    await updateClaim({
      id: input.claimId,
      admissionOutcome: "blocked",
      rejectionReason: admission.reason,
      correlatedExposureBeforeCents: admission.currentExposureCents,
      proposedExposureCents: input.requestedRiskCents,
      sharedExposureCapCents: admission.capCents,
      lifecycleState: "REJECTED",
    }).catch(() => false);
    return {
      outcome: admission.reason === "cap_exceeded" ? "correlated_cap_blocked" : "correlated_cap_unavailable",
      reservationId: null,
      currentExposureCents: admission.currentExposureCents,
      postTradeExposureCents: admission.postTradeExposureCents,
      capCents: admission.capCents,
    };
  }

  const admittedWritten = await updateClaim({
    id: input.claimId,
    admissionOutcome: "admitted",
    rejectionReason: null,
    correlatedExposureBeforeCents: admission.currentExposureCents,
    proposedExposureCents: input.requestedRiskCents,
    sharedExposureCapCents: admission.capCents,
    lifecycleState: "ADMITTED",
  });
  if (!admittedWritten) {
    await store.transition({
      id: reservationId,
      from: "reserved",
      to: "released",
      updatedAtMs: Date.now(),
    }).catch(() => false);
    return empty("persistence_failed");
  }

  return {
    outcome: "admitted",
    reservationId,
    currentExposureCents: admission.currentExposureCents,
    postTradeExposureCents: admission.postTradeExposureCents,
    capCents: admission.capCents,
  };
}
