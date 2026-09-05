/**
 * Shared account-level capital guard for isolated ETH services.
 *
 * Strategy state remains independent, but cash is not. B/C may submit only
 * from capital left after protecting A's required reserve, an account safety
 * buffer, and already-reserved B/C exposure.
 */
export interface EthAccountCapitalInput {
  availableBalanceCents: number;
  martingaleReserveCents: number;
  safetyReserveCents: number;
  otherBigBetReservedCents: number;
  requestedRiskCents: number;
}

export type EthAccountCapitalDecision =
  | { allowed: true; freeAfterReservationCents: number }
  | { allowed: false; reason: "invalid_input" | "insufficient_unreserved_capital"; freeBeforeReservationCents: number | null };

function validNonnegativeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateEthAccountCapital(input: EthAccountCapitalInput): EthAccountCapitalDecision {
  if (![input.availableBalanceCents, input.martingaleReserveCents, input.safetyReserveCents,
    input.otherBigBetReservedCents, input.requestedRiskCents].every(validNonnegativeCents)
    || input.requestedRiskCents === 0) {
    return { allowed: false, reason: "invalid_input", freeBeforeReservationCents: null };
  }
  const protectedCents = input.martingaleReserveCents + input.safetyReserveCents + input.otherBigBetReservedCents;
  const freeBeforeReservationCents = input.availableBalanceCents - protectedCents;
  if (freeBeforeReservationCents < input.requestedRiskCents) {
    return { allowed: false, reason: "insufficient_unreserved_capital", freeBeforeReservationCents };
  }
  return { allowed: true, freeAfterReservationCents: freeBeforeReservationCents - input.requestedRiskCents };
}
