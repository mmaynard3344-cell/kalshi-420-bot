/**
 * Shared ETH martingale transition rules. REVIEW ONLY; no production wiring.
 * Step is zero-based. The first signal must atomically claim the single shared
 * ETH slot in the database; calling these pure functions is NOT a lock.
 */
export const ETH_SHARED_STAKES_CENTS = [200,400,800,1600,3200,6400] as const;
export type EthSettlement = "WIN" | "LOSS" | "ZERO_FILL";
export type EthSharedLadderState = Readonly<{
  step: number;
  activeClaimId: string | null;
  version: number;
}>;
export function wagerCents(step: number): number {
  if (!Number.isInteger(step) || step < 0 || step >= ETH_SHARED_STAKES_CENTS.length) {
    throw new RangeError("invalid ETH ladder step");
  }
  return ETH_SHARED_STAKES_CENTS[step];
}
export function nextStep(step: number, settlement: EthSettlement): number {
  wagerCents(step);
  switch (settlement) {
    case "WIN": return 0;
    case "ZERO_FILL": return step;
    case "LOSS": return step + 1 >= ETH_SHARED_STAKES_CENTS.length ? 0 : step + 1;
    default: throw new RangeError("invalid settlement");
  }
}
export function resolveClaim(
  state: EthSharedLadderState,
  claimId: string,
  settlement: EthSettlement
): EthSharedLadderState {
  if (!claimId || state.activeClaimId !== claimId) {
    throw new Error("settlement does not match active ETH claim");
  }
  return {step: nextStep(state.step, settlement), activeClaimId: null, version: state.version + 1};
}
