export type EthAshV2OldCapitalDecision = "allowed" | "capital_blocked" | "capital_unavailable";

export type EthAshV2ProposedPolicyDecision =
  | "shadow_allow"
  | "shadow_block"
  | "shadow_unavailable";

export interface EthAshV2ShadowCapitalInput {
  strategy: string;
  ticker: string;
  exchangeIndex: number;
  requestedRiskCents: number;
  oldPolicyDecision: EthAshV2OldCapitalDecision;
  oldPolicyBlocker: string | null;
  proposedAvailableBalanceCents: number | null;
  proposedInflightReservedCents: number | null;
  timestamp: number;
  deploymentVersion: string | null;
}

export interface EthAshV2ShadowCapitalEvent {
  service: "I";
  strategy: string;
  ticker: string;
  exchange_index: number;
  requested_risk_cents: number;
  old_policy_decision: EthAshV2OldCapitalDecision;
  old_policy_blocker: string | null;
  proposed_available_balance_cents: number | null;
  proposed_inflight_reserved_cents: number | null;
  proposed_free_capital_cents: number | null;
  proposed_policy_decision: EthAshV2ProposedPolicyDecision;
  would_have_admitted: boolean;
  timestamp: number;
  deployment_version: string | null;
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Service I shadow-only capital comparison.
 *
 * Pure calculation only:
 * - no balance read;
 * - no database access;
 * - no reservation insert;
 * - no order submission;
 * - no effect on the caller's old-policy enforcement decision.
 */
export function buildEthAshV2ShadowCapitalEvent(
  input: EthAshV2ShadowCapitalInput,
): EthAshV2ShadowCapitalEvent {
  const validIdentity =
    input.strategy.length > 0
    && /^KXETH15M-/.test(input.ticker)
    && nonnegativeSafeInteger(input.exchangeIndex)
    && Number.isSafeInteger(input.requestedRiskCents)
    && input.requestedRiskCents > 0
    && nonnegativeSafeInteger(input.timestamp);

  const hasProposedFacts =
    validIdentity
    && input.proposedAvailableBalanceCents != null
    && input.proposedInflightReservedCents != null
    && nonnegativeSafeInteger(input.proposedAvailableBalanceCents)
    && nonnegativeSafeInteger(input.proposedInflightReservedCents);

  const proposedFreeCapitalCents = hasProposedFacts
    ? input.proposedAvailableBalanceCents! - input.proposedInflightReservedCents!
    : null;

  const proposedPolicyDecision: EthAshV2ProposedPolicyDecision =
    proposedFreeCapitalCents == null
      ? "shadow_unavailable"
      : proposedFreeCapitalCents >= input.requestedRiskCents
        ? "shadow_allow"
        : "shadow_block";

  return {
    service: "I",
    strategy: input.strategy,
    ticker: input.ticker,
    exchange_index: input.exchangeIndex,
    requested_risk_cents: input.requestedRiskCents,
    old_policy_decision: input.oldPolicyDecision,
    old_policy_blocker: input.oldPolicyBlocker,
    proposed_available_balance_cents: input.proposedAvailableBalanceCents,
    proposed_inflight_reserved_cents: input.proposedInflightReservedCents,
    proposed_free_capital_cents: proposedFreeCapitalCents,
    proposed_policy_decision: proposedPolicyDecision,
    would_have_admitted: proposedPolicyDecision === "shadow_allow",
    timestamp: input.timestamp,
    deployment_version: input.deploymentVersion,
  };
}
