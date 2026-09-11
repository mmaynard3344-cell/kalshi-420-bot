import type { EthAccountCapitalInput } from "./ethAccountCapitalGuard.js";
import type { EthBigBetCapitalFacts } from "./ethBigBetCapitalFacts.js";

export interface EthBigBetReservePolicy {
  /** Explicit cash reserved for Service A. No default is permitted here. */
  martingaleReserveCents: number;
  /** Explicit additional account-level safety reserve. No default is permitted here. */
  safetyReserveCents: number;
}

function validReserve(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Converts authoritative account facts + an explicitly supplied reserve policy
 * into the capital-guard input shared by B/C.
 *
 * This function deliberately has no defaults, no environment reads, and no
 * strategy-state reads. If either reserve is missing/invalid, callers receive
 * null and therefore cannot authorize a big-bet order.
 */
export function buildEthBigBetCapitalBase(
  facts: EthBigBetCapitalFacts | null,
  policy: EthBigBetReservePolicy | null,
): Omit<EthAccountCapitalInput, "requestedRiskCents"> | null {
  if (!facts || !policy) return null;
  if (!Number.isSafeInteger(facts.exchangeIndex) || facts.exchangeIndex < 0
    || !validReserve(facts.availableBalanceCents)
    || !validReserve(facts.otherBigBetReservedCents)
    || !validReserve(policy.martingaleReserveCents)
    || !validReserve(policy.safetyReserveCents)) return null;

  return {
    availableBalanceCents: facts.availableBalanceCents,
    martingaleReserveCents: policy.martingaleReserveCents,
    safetyReserveCents: policy.safetyReserveCents,
    otherBigBetReservedCents: facts.otherBigBetReservedCents,
  };
}
