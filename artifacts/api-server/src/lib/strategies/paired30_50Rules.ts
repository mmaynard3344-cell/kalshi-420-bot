/** Shared, dependency-free eligibility rules for the ETH/SOL paired 30–50 entry.
 *
 * A pair is intentionally all-or-nothing at the reservation boundary: both
 * outcome books must be independently executable before either child is sent.
 */
export const PAIRED30_LOW_MIN_CENTS = 20;
export const PAIRED30_LOW_MAX_CENTS = 30;
export const PAIRED30_HIGH_MIN_CENTS = 70;
export const PAIRED30_HIGH_MAX_CENTS = 80;
export const PAIRED30_SIDE_PRINCIPAL_CAP_CENTS = 100;
export const PAIRED30_MARKET_PRINCIPAL_CAP_CENTS = 200;

export type Paired30Side = "yes" | "no";
export interface Paired30Leg {
  side: Paired30Side;
  priceCents: number;
  availableContracts: number;
  contracts: number;
}
export interface Paired30Plan {
  yes: Paired30Leg;
  no: Paired30Leg;
  totalPrincipalCents: number;
}

/** The expensive leg of a complementary pair is intentionally held through
 * settlement. A 50¢ target on this leg would be immediately marketable. */
export function isPaired30HighLeg(priceCents: number): boolean {
  return Number.isInteger(priceCents)
    && priceCents >= PAIRED30_HIGH_MIN_CENTS
    && priceCents <= PAIRED30_HIGH_MAX_CENTS;
}

function contractsForPrincipal(priceCents: number, depth: number): number {
  if (!Number.isInteger(priceCents) || priceCents <= 0) return 0;
  return Math.max(0, Math.min(
    Math.floor(PAIRED30_SIDE_PRINCIPAL_CAP_CENTS / priceCents),
    Math.floor(Math.max(0, depth)),
  ));
}

/** Returns a bounded plan only for complementary 20–30¢ and 70–80¢ books. */
export function planPaired30Entry(
  yesPriceCents: number | null,
  yesDepth: number | null,
  noPriceCents: number | null,
  noDepth: number | null,
): Paired30Plan | null {
  if (yesPriceCents == null || noPriceCents == null || yesDepth == null || noDepth == null) return null;
  const yesLow = yesPriceCents >= PAIRED30_LOW_MIN_CENTS && yesPriceCents <= PAIRED30_LOW_MAX_CENTS;
  const noLow = noPriceCents >= PAIRED30_LOW_MIN_CENTS && noPriceCents <= PAIRED30_LOW_MAX_CENTS;
  const yesHigh = yesPriceCents >= PAIRED30_HIGH_MIN_CENTS && yesPriceCents <= PAIRED30_HIGH_MAX_CENTS;
  const noHigh = noPriceCents >= PAIRED30_HIGH_MIN_CENTS && noPriceCents <= PAIRED30_HIGH_MAX_CENTS;
  if (!((yesLow && noHigh) || (noLow && yesHigh))) return null;

  const yesContracts = contractsForPrincipal(yesPriceCents, yesDepth);
  const noContracts = contractsForPrincipal(noPriceCents, noDepth);
  if (yesContracts <= 0 || noContracts <= 0) return null;
  const totalPrincipalCents = yesContracts * yesPriceCents + noContracts * noPriceCents;
  if (totalPrincipalCents > PAIRED30_MARKET_PRINCIPAL_CAP_CENTS) return null;
  return {
    yes: { side: "yes", priceCents: yesPriceCents, availableContracts: Math.floor(yesDepth), contracts: yesContracts },
    no: { side: "no", priceCents: noPriceCents, availableContracts: Math.floor(noDepth), contracts: noContracts },
    totalPrincipalCents,
  };
}