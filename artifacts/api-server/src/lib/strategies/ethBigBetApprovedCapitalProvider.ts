import type { EthAccountCapitalInput } from "./ethAccountCapitalGuard.js";
import { readEthBigBetCapitalFacts } from "./ethBigBetCapitalFacts.js";
import { buildEthBigBetCapitalBase } from "./ethBigBetCapitalPolicy.js";

function requiredPositiveIntegerEnv(name: string): number {
  const raw = process.env[name];
  const parsed = raw == null ? NaN : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Missing or invalid ${name}`);
  return parsed;
}

function withFeeHeadroom(principalCents: number): number { return Math.ceil(principalCents * 1.035); }

export function deriveEthBigBetProtectedBaseFromLiveConfig() {
  const aMaxStepCents = requiredPositiveIntegerEnv("ETH_MARTINGALE_MAX_STEP_CENTS");
  const bWagerCents = requiredPositiveIntegerEnv("ETH_B_WAGER_CENTS");
  const cWagerCents = requiredPositiveIntegerEnv("ETH_C_WAGER_CENTS");
  const martingaleReserveCents = withFeeHeadroom(aMaxStepCents);
  const safetyReserveCents = withFeeHeadroom(Math.max(bWagerCents, cWagerCents));
  return { martingaleReserveCents, safetyReserveCents, totalProtectedBaseCents: martingaleReserveCents + safetyReserveCents, aMaxStepCents, bWagerCents, cWagerCents };
}

const configuredReserve = deriveEthBigBetProtectedBaseFromLiveConfig();
export const ETH_BIG_BET_MARTINGALE_RESERVE_CENTS = configuredReserve.martingaleReserveCents;
export const ETH_BIG_BET_SAFETY_RESERVE_CENTS = configuredReserve.safetyReserveCents;
export const ETH_BIG_BET_TOTAL_PROTECTED_BASE_CENTS = configuredReserve.totalProtectedBaseCents;
console.info("ETH_BIG_BET_RESERVE_ACTIVE", configuredReserve);

export async function readApprovedEthBigBetCapitalBase(exchangeIndex: number): Promise<Omit<EthAccountCapitalInput, "requestedRiskCents"> | null> {
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) return null;
  const facts = await readEthBigBetCapitalFacts(exchangeIndex);
  return buildEthBigBetCapitalBase(facts, { martingaleReserveCents: ETH_BIG_BET_MARTINGALE_RESERVE_CENTS, safetyReserveCents: ETH_BIG_BET_SAFETY_RESERVE_CENTS });
}
