import type { EthAccountCapitalInput } from "./ethAccountCapitalGuard.js";
import { readEthBigBetCapitalFacts } from "./ethBigBetCapitalFacts.js";
import { buildEthBigBetCapitalBase } from "./ethBigBetCapitalPolicy.js";

/**
 * Explicitly approved reserve policy for the staged B/C services.
 *
 * These values do not enable execution. B and C retain independent hard code
 * fences. The provider is read only and returns null on any unavailable,
 * stale, or malformed account evidence.
 */
export const ETH_BIG_BET_MARTINGALE_RESERVE_CENTS = 43_470;
export const ETH_BIG_BET_SAFETY_RESERVE_CENTS = 51_750;
export const ETH_BIG_BET_TOTAL_PROTECTED_BASE_CENTS =
  ETH_BIG_BET_MARTINGALE_RESERVE_CENTS + ETH_BIG_BET_SAFETY_RESERVE_CENTS;

export async function readApprovedEthBigBetCapitalBase(
  exchangeIndex: number,
): Promise<Omit<EthAccountCapitalInput, "requestedRiskCents"> | null> {
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) return null;
  const facts = await readEthBigBetCapitalFacts(exchangeIndex);
  return buildEthBigBetCapitalBase(facts, {
    martingaleReserveCents: ETH_BIG_BET_MARTINGALE_RESERVE_CENTS,
    safetyReserveCents: ETH_BIG_BET_SAFETY_RESERVE_CENTS,
  });
}
