/**
 * Narrow, opt-in replacement rule for a completely unfilled ETH420 primary.
 *
 * This module deliberately owns no ladder state.  A caller may only invoke the
 * exchange callbacks after it has durably claimed an attempt, and must cancel
 * the primary to a terminal, explicit zero-fill state before posting a
 * replacement.  Keeping the decision here pure makes the safety contract
 * independently testable from the candidate's settlement lifecycle.
 */
import type { Eth420Side } from "./eth420SixStepCandidate.js";

export const ETH420_SECONDARY_ENTRY_OFFSET_MS = 10_000;
export const ETH420_SECONDARY_ENTRY_MAX_ASK_CENTS = 65;
/** A timer may be delayed briefly by the event loop, but a later activation or
 * restart must never turn an old primary into a retrospective cross attempt. */
export const ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS = 1_000;

/** Separate opt-in; it intentionally defaults to false and is never implied by
 * the primary candidate execution flag. */
export function isEth420SecondaryEntryPermitted(): boolean {
  return process.env["ETH_420_CANDIDATE_LIVE_ENABLED"] === "true"
    && process.env["ETH_420_CANDIDATE_SECONDARY_CROSS_ENABLED"] === "true";
}

export type Eth420SecondaryEntryBlockReason =
  | "secondary_not_permitted"
  | "activation_cutover_missing"
  | "pre_activation_primary"
  | "before_offset"
  | "missed_offset"
  | "primary_identity_missing"
  | "primary_identity_mismatch"
  | "primary_status_uncertain"
  | "primary_fill_uncertain"
  | "primary_partially_filled"
  | "reservation_ask_unavailable"
  | "current_ask_unavailable"
  | "ask_not_above_primary_limit"
  | "ask_declined"
  | "ask_above_ceiling"
  | "attempt_already_claimed"
  | "cancel_audit_failed"
  | "cancel_not_terminal"
  | "cancel_fill_uncertain"
  | "cancel_nonzero_fill"
  | "secondary_checkpoint_failed"
  | "secondary_acknowledgement_uncertain";

export type Eth420SecondaryEntryDecision =
  | { eligible: true; crossPriceCents: number }
  | { eligible: false; reason: Eth420SecondaryEntryBlockReason };

export function evaluateEth420SecondaryEntry(input: {
  reservationAskCents: number | null;
  currentAskCents: number | null;
  primaryLimitPriceCents: number;
  primaryFilledContracts: number | null;
}): Eth420SecondaryEntryDecision {
  if (!Number.isInteger(input.primaryFilledContracts) || input.primaryFilledContracts! < 0) {
    return { eligible: false, reason: "primary_fill_uncertain" };
  }
  if (input.primaryFilledContracts !== 0) return { eligible: false, reason: "primary_partially_filled" };
  if (!Number.isInteger(input.reservationAskCents) || input.reservationAskCents! < 1 || input.reservationAskCents! > 99) {
    return { eligible: false, reason: "reservation_ask_unavailable" };
  }
  if (!Number.isInteger(input.currentAskCents) || input.currentAskCents! < 1 || input.currentAskCents! > 99) {
    return { eligible: false, reason: "current_ask_unavailable" };
  }
  if (input.currentAskCents! <= input.primaryLimitPriceCents) return { eligible: false, reason: "ask_not_above_primary_limit" };
  if (input.currentAskCents! < input.reservationAskCents!) return { eligible: false, reason: "ask_declined" };
  if (input.currentAskCents! > ETH420_SECONDARY_ENTRY_MAX_ASK_CENTS) return { eligible: false, reason: "ask_above_ceiling" };
  return { eligible: true, crossPriceCents: input.currentAskCents! };
}

export interface Eth420SecondaryEntryPrimary {
  id: string;
  ticker: string;
  side: Eth420Side;
  requestedContracts: number;
  limitPriceCents: number;
  kalshiOrderId: string | null;
  createdAtMs: number;
  secondaryActivationSequence?: number;
}

export interface Eth420SecondaryEntryExchangeOrder {
  orderId: string;
  clientOrderId: string;
  ticker: string;
  status: string | null;
  filledContracts: number | null;
}

export interface Eth420SecondaryActivationPrimary {
  id: string;
  ticker: string;
  createdAtMs: number;
  secondaryActivationSequence?: number;
  kalshiOrderId: string | null;
  originalPrimaryKalshiOrderId?: string | null;
  secondaryClientOrderId?: string | null;
  primaryCancelConfirmedAtMs?: number | null;
  secondarySubmissionStartedAtMs?: number | null;
  secondaryBoundAtMs?: number | null;
  /** A durable cancel/submit lifecycle audit can precede the corresponding
   * candidate-row transition; it remains activation-blocking in that gap. */
  secondaryLifecycleTransitionActive?: boolean;
  status: string;
  filledContracts: number | null;
  settlementResult: "yes" | "no" | null;
  lastRecoveryOutcome?: string | null;
}

export type Eth420SecondaryActivationReadiness =
  | { ready: true }
  | { ready: false; reason: "no_active_primary" | "primary_not_ordinary" | "lifecycle_transition_ambiguous" | "local_fill_nonzero" | "exchange_identity_uncertain" | "exchange_not_resting" | "exchange_fill_uncertain" | "exchange_fill_nonzero" };

export type Eth420SecondaryGlobalActivationBlocker =
  | "production_unhealthy"
  | "candidate_ledger_unavailable"
  | "candidate_ledger_incomplete"
  | "emergency_lifecycle_exists"
  | "activation_cutover_missing"
  | Exclude<Eth420SecondaryActivationReadiness, { ready: true }>["reason"];

export interface Eth420SecondaryGlobalActivationCandidate {
  primary: Eth420SecondaryActivationPrimary;
  exchangeOrder: Eth420SecondaryEntryExchangeOrder | null;
}

export interface Eth420SecondaryGlobalActivationAssessment {
  safe: boolean;
  blockers: Array<{ candidateId: string | null; reason: Eth420SecondaryGlobalActivationBlocker }>;
}

export interface Eth420SecondaryEntryStore {
  /** Immutable boundary: only primaries reserved at/after it may ever cross. */
  getEth420SecondaryActivationCutover(): Promise<{ version: 1; activatedAtMs: number; reservationSequence?: number } | null>;
  /** An atomic, durable once-only fence. False means a prior attempt owns it. */
  claimEth420SecondaryEntryAttempt(params: {
    candidateOrderId: string; attemptedAtMs: number; reservationAskCents: number | null;
  }): Promise<boolean>;
  recordEth420SecondaryEntryEvent(params: {
    candidateOrderId: string; atMs: number; event: string; reason: string | null;
    reservationAskCents: number | null; currentAskCents: number | null;
    primaryOrderId?: string | null; secondaryClientOrderId?: string | null; secondaryOrderId?: string | null;
  }): Promise<boolean>;
  /** Durable pre-POST transition. A false result must prevent the POST. */
  markEth420CandidateSecondarySubmissionPending(
    id: string, primaryOrderId: string, clientOrderId: string,
  ): Promise<boolean>;
}

function isExactPrimary(
  primary: Pick<Eth420SecondaryEntryPrimary, "id" | "ticker" | "kalshiOrderId">,
  wire: Eth420SecondaryEntryExchangeOrder | null,
): boolean {
  return wire?.orderId === primary.kalshiOrderId && wire.clientOrderId === primary.id && wire.ticker === primary.ticker;
}

/**
 * Read-only operator activation gate. A local submitted row is not enough:
 * activation is safe only after the exchange confirms the exact primary is
 * still resting with an explicit zero fill and no local transition exists.
 */
export function evaluateEth420SecondaryActivationReadiness(
  primary: Eth420SecondaryActivationPrimary | null,
  exchangeOrder: Eth420SecondaryEntryExchangeOrder | null,
): Eth420SecondaryActivationReadiness {
  if (!primary) return { ready: false, reason: "no_active_primary" };
  if (primary.status !== "submitted" || !primary.kalshiOrderId
    || (primary.originalPrimaryKalshiOrderId != null && primary.originalPrimaryKalshiOrderId !== primary.kalshiOrderId)) {
    return { ready: false, reason: "primary_not_ordinary" };
  }
  if (primary.secondaryClientOrderId != null || primary.primaryCancelConfirmedAtMs != null
    || primary.secondarySubmissionStartedAtMs != null || primary.secondaryBoundAtMs != null
    || primary.secondaryLifecycleTransitionActive === true
    || primary.settlementResult != null || primary.lastRecoveryOutcome != null) {
    return { ready: false, reason: "lifecycle_transition_ambiguous" };
  }
  if (primary.filledContracts != null && (!Number.isInteger(primary.filledContracts) || primary.filledContracts !== 0)) {
    return { ready: false, reason: "local_fill_nonzero" };
  }
  const verifiedOrder = exchangeOrder;
  if (!verifiedOrder || !isExactPrimary(primary, verifiedOrder)) return { ready: false, reason: "exchange_identity_uncertain" };
  if (verifiedOrder.status?.toLowerCase() !== "resting") return { ready: false, reason: "exchange_not_resting" };
  const exchangeFilledContracts = verifiedOrder.filledContracts;
  if (typeof exchangeFilledContracts !== "number" || !Number.isInteger(exchangeFilledContracts) || exchangeFilledContracts < 0) {
    return { ready: false, reason: "exchange_fill_uncertain" };
  }
  if (exchangeFilledContracts !== 0) return { ready: false, reason: "exchange_fill_nonzero" };
  return { ready: true };
}

/**
 * Read-only global release assessment. It is deliberately not consulted by the
 * execution path: SAFE is operator evidence only, never authorization to flip
 * a flag, schedule a callback, cancel a primary, or submit a replacement.
 *
 * A clean resting primary is non-blocking. Every unresolved candidate must
 * independently meet that exact proof; unknown evidence is never treated as
 * zero exposure.
 */
export function assessEth420SecondaryGlobalActivation(input: {
  productionHealthy: boolean;
  candidateLedgerAvailable: boolean;
  candidateLedgerComplete: boolean;
  emergencyLifecycleExists: boolean;
  activationCutover: { version: 1; activatedAtMs: number; reservationSequence?: number } | null;
  candidates: Eth420SecondaryGlobalActivationCandidate[];
}): Eth420SecondaryGlobalActivationAssessment {
  const blockers: Eth420SecondaryGlobalActivationAssessment["blockers"] = [];
  if (!input.productionHealthy) blockers.push({ candidateId: null, reason: "production_unhealthy" });
  if (!input.candidateLedgerAvailable) blockers.push({ candidateId: null, reason: "candidate_ledger_unavailable" });
  if (!input.candidateLedgerComplete) blockers.push({ candidateId: null, reason: "candidate_ledger_incomplete" });
  if (input.emergencyLifecycleExists) blockers.push({ candidateId: null, reason: "emergency_lifecycle_exists" });
  if (!input.activationCutover) blockers.push({ candidateId: null, reason: "activation_cutover_missing" });
  for (const candidate of input.candidates) {
    // Rows created before the immutable cutover are deliberately grandfathered:
    // they stay primary-only and cannot block a forward-only release.
    if (input.activationCutover && (candidate.primary.createdAtMs < input.activationCutover.activatedAtMs
      || (input.activationCutover.reservationSequence != null
        && (!Number.isSafeInteger(candidate.primary.secondaryActivationSequence)
          || candidate.primary.secondaryActivationSequence! <= input.activationCutover.reservationSequence)))) continue;
    const readiness = evaluateEth420SecondaryActivationReadiness(candidate.primary, candidate.exchangeOrder);
    if (!readiness.ready) blockers.push({ candidateId: candidate.primary.id, reason: readiness.reason });
  }
  return { safe: blockers.length === 0, blockers };
}

export function isEth420SecondaryDecisionOnTime(createdAtMs: number, nowMs: number): boolean {
  return Number.isInteger(createdAtMs) && Number.isInteger(nowMs)
    && nowMs >= createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS
    && nowMs <= createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS + ETH420_SECONDARY_ENTRY_MAX_TIMER_LATENESS_MS;
}

function terminal(status: string | null): boolean {
  return status != null && ["canceled", "cancelled", "executed", "filled"].includes(status.toLowerCase());
}

/**
 * Executes one candidate replacement attempt. It does not settle any order or
 * touch candidate state; the caller must make the primary+replacement pair a
 * single logical settlement before wiring this to a live exchange executor.
 */
export async function tryEth420SecondaryEntry(params: {
  store: Eth420SecondaryEntryStore;
  primary: Eth420SecondaryEntryPrimary;
  reservationAskCents: number | null;
  nowMs: number;
  /** Production passes the wall clock so an async delay cannot cross the
   * deadline after the timer callback first begins. */
  getCurrentTimeMs?: () => number;
  readPrimary: () => Promise<Eth420SecondaryEntryExchangeOrder | null>;
  readSelectedSideAsk: () => Promise<number | null>;
  cancelPrimary: () => Promise<Eth420SecondaryEntryExchangeOrder | null>;
  submitSecondary: (request: {
    clientOrderId: string; ticker: string; side: Eth420Side; contracts: number; priceCents: number;
  }) => Promise<{ orderId: string | null }>;
}): Promise<Eth420SecondaryEntryDecision> {
  const block = async (reason: Eth420SecondaryEntryBlockReason, currentAskCents: number | null = null) => {
    await params.store.recordEth420SecondaryEntryEvent({
      candidateOrderId: params.primary.id, atMs: params.nowMs, event: "blocked", reason,
      reservationAskCents: params.reservationAskCents, currentAskCents,
    });
    return { eligible: false as const, reason };
  };
  if (!isEth420SecondaryEntryPermitted()) return block("secondary_not_permitted");
  const activationCutover = await params.store.getEth420SecondaryActivationCutover();
  if (!activationCutover) return block("activation_cutover_missing");
  if (params.primary.createdAtMs < activationCutover.activatedAtMs
    || (activationCutover.reservationSequence != null
      && (!Number.isSafeInteger(params.primary.secondaryActivationSequence)
        || params.primary.secondaryActivationSequence! <= activationCutover.reservationSequence))) return block("pre_activation_primary");
  if (params.nowMs < params.primary.createdAtMs + ETH420_SECONDARY_ENTRY_OFFSET_MS) return block("before_offset");
  if (!isEth420SecondaryDecisionOnTime(params.primary.createdAtMs, params.nowMs)) return block("missed_offset");
  const currentTimeMs = params.getCurrentTimeMs ?? (() => params.nowMs);
  if (!params.primary.kalshiOrderId) return block("primary_identity_missing");
  if (!await params.store.claimEth420SecondaryEntryAttempt({
    candidateOrderId: params.primary.id, attemptedAtMs: params.nowMs, reservationAskCents: params.reservationAskCents,
  })) return block("attempt_already_claimed");

  const beforeCancel = await params.readPrimary();
  if (!isExactPrimary(params.primary, beforeCancel)) return block("primary_identity_mismatch");
  if (!beforeCancel) return block("primary_identity_mismatch");
  if (beforeCancel.status?.toLowerCase() !== "resting") return block("primary_status_uncertain");
  const currentAskCents = await params.readSelectedSideAsk();
  const decision = evaluateEth420SecondaryEntry({
    reservationAskCents: params.reservationAskCents, currentAskCents,
    primaryLimitPriceCents: params.primary.limitPriceCents, primaryFilledContracts: beforeCancel.filledContracts,
  });
  if (!decision.eligible) return block(decision.reason, currentAskCents);
  // The timer may have started at the intended offset but awaited exchange
  // reads long enough to become stale. Never cancel a primary after that
  // deadline, because activation must remain forward-only.
  if (!isEth420SecondaryDecisionOnTime(params.primary.createdAtMs, currentTimeMs())) {
    return block("missed_offset", currentAskCents);
  }

  const cancelAuditRecorded = await params.store.recordEth420SecondaryEntryEvent({
    candidateOrderId: params.primary.id, atMs: params.nowMs, event: "cancel_requested", reason: null,
    reservationAskCents: params.reservationAskCents, currentAskCents, primaryOrderId: params.primary.kalshiOrderId,
  });
  // The global assessment must always be able to distinguish a clean resting
  // primary from a cancellation that has begun. Never start an exchange cancel
  // without the durable transition evidence that makes it fail-closed.
  if (!cancelAuditRecorded) return block("cancel_audit_failed", currentAskCents);
  if (!isEth420SecondaryDecisionOnTime(params.primary.createdAtMs, currentTimeMs())) {
    return block("missed_offset", currentAskCents);
  }
  const cancelled = await params.cancelPrimary();
  if (!isExactPrimary(params.primary, cancelled) || !terminal(cancelled?.status ?? null)) return block("cancel_not_terminal", currentAskCents);
  if (!cancelled) return block("cancel_not_terminal", currentAskCents);
  if (!Number.isInteger(cancelled.filledContracts) || cancelled.filledContracts! < 0) return block("cancel_fill_uncertain", currentAskCents);
  if (cancelled.filledContracts !== 0) return block("cancel_nonzero_fill", currentAskCents);
  const secondaryClientOrderId = `${params.primary.id}:secondary-v1`;
  await params.store.recordEth420SecondaryEntryEvent({
    candidateOrderId: params.primary.id, atMs: params.nowMs, event: "cancel_confirmed", reason: null,
    reservationAskCents: params.reservationAskCents, currentAskCents,
    primaryOrderId: params.primary.kalshiOrderId, secondaryClientOrderId,
  });
  if (!await params.store.markEth420CandidateSecondarySubmissionPending(
    params.primary.id, params.primary.kalshiOrderId, secondaryClientOrderId,
  )) return block("secondary_checkpoint_failed", currentAskCents);
  // Cancellation was admitted before the deadline. If durable checkpointing
  // itself crosses it, retain the checkpoint for reconciliation but never
  // submit a late replacement.
  if (!isEth420SecondaryDecisionOnTime(params.primary.createdAtMs, currentTimeMs())) {
    return block("missed_offset", currentAskCents);
  }
  await params.store.recordEth420SecondaryEntryEvent({
    candidateOrderId: params.primary.id, atMs: params.nowMs, event: "submit_started", reason: null,
    reservationAskCents: params.reservationAskCents, currentAskCents,
    primaryOrderId: params.primary.kalshiOrderId, secondaryClientOrderId,
  });
  if (!isEth420SecondaryDecisionOnTime(params.primary.createdAtMs, currentTimeMs())) {
    return block("missed_offset", currentAskCents);
  }
  const secondary = await params.submitSecondary({
    clientOrderId: secondaryClientOrderId, ticker: params.primary.ticker, side: params.primary.side,
    contracts: params.primary.requestedContracts, priceCents: decision.crossPriceCents,
  });
  if (!secondary.orderId) return block("secondary_acknowledgement_uncertain", currentAskCents);
  await params.store.recordEth420SecondaryEntryEvent({
    candidateOrderId: params.primary.id, atMs: params.nowMs, event: "bind_confirmed", reason: null,
    reservationAskCents: params.reservationAskCents, currentAskCents,
    primaryOrderId: params.primary.kalshiOrderId, secondaryClientOrderId, secondaryOrderId: secondary.orderId,
  });
  return decision;
}