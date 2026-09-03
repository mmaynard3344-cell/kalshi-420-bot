/** Dependency-free ETH_30_50 eligibility and arithmetic rules. */
export const ETH30_STRATEGY_ID = "ETH_30_50" as const;
export const ETH30_ENTRY_MIN_CENTS = 23;
export const ETH30_ENTRY_CAP_CENTS = 28;
export const ETH30_LOW_TIER_MAX_CENTS = 25;
export const ETH30_TARGET_CENTS = 50;
export const ETH30_WINDOW_MS = 5 * 60_000;
export const ETH30_PRINCIPAL_CAP_CENTS = 100; // Maximum ETH_30_50 entry principal.
export const ETH30_HIGH_TIER_PRINCIPAL_CAP_CENTS = 100;
export { PAIRED30_SIDE_PRINCIPAL_CAP_CENTS, PAIRED30_MARKET_PRINCIPAL_CAP_CENTS, planPaired30Entry } from "./paired30_50Rules.js";

export type Eth30EntryPriceBucket = "LE_22" | "23_25" | "26_28" | "29_30" | "GT_30";

export function eth30EntryPriceBucket(executableCents: number): Eth30EntryPriceBucket {
  if (executableCents <= 22) return "LE_22";
  if (executableCents <= ETH30_LOW_TIER_MAX_CENTS) return "23_25";
  if (executableCents <= ETH30_ENTRY_CAP_CENTS) return "26_28";
  if (executableCents <= 30) return "29_30";
  return "GT_30";
}

/** Null means the executable price is intentionally outside the live band. */
export function eth30PrincipalCapForEntryPrice(executableCents: number): number | null {
  if (!Number.isInteger(executableCents) || executableCents < ETH30_ENTRY_MIN_CENTS || executableCents > ETH30_ENTRY_CAP_CENTS) {
    return null;
  }
  return executableCents <= ETH30_LOW_TIER_MAX_CENTS
    ? ETH30_PRINCIPAL_CAP_CENTS
    : ETH30_HIGH_TIER_PRINCIPAL_CAP_CENTS;
}

/** Safe to expose in read-only reports and runtime health evidence. */
export function eth30EntryPolicy() {
  return {
    entryMinCents: ETH30_ENTRY_MIN_CENTS,
    entryMaxCents: ETH30_ENTRY_CAP_CENTS,
    lowTier: {
      priceMinCents: ETH30_ENTRY_MIN_CENTS,
      priceMaxCents: ETH30_LOW_TIER_MAX_CENTS,
      principalCapCents: ETH30_PRINCIPAL_CAP_CENTS,
    },
    highTier: {
      priceMinCents: ETH30_LOW_TIER_MAX_CENTS + 1,
      priceMaxCents: ETH30_ENTRY_CAP_CENTS,
      principalCapCents: ETH30_HIGH_TIER_PRINCIPAL_CAP_CENTS,
    },
    targetCents: ETH30_TARGET_CENTS,
  };
}

export function isEth30Ticker(ticker: string): boolean {
  return ticker.split("-", 1)[0] === "KXETH15M";
}
export function isEth30OpeningWindow(openTime: string | null, nowMs = Date.now()): boolean {
  if (!openTime) return false;
  const opened = new Date(openTime).getTime();
  return Number.isFinite(opened) && nowMs >= opened && nowMs < opened + ETH30_WINDOW_MS;
}
export function contractsForEth30Capacity(remainingCents: number, executableCents: number, depth: number): number {
  const tierCap = eth30PrincipalCapForEntryPrice(executableCents);
  if (tierCap === null) return 0;
  // A caller cannot accidentally turn this into a larger entry merely by
  // passing more budget than the approved tier permits.
  const cappedPrincipal = Math.min(Math.max(0, Math.floor(remainingCents)), tierCap);
  return Math.max(0, Math.min(Math.floor(cappedPrincipal / executableCents), Math.floor(depth)));
}

/** Explicit pure boundary for the feature flag, global halt, and profit stop. */
export function mayEnterEth30(enabled: boolean, globallyHalted: boolean, investmentAllowed: boolean): boolean {
  return enabled && !globallyHalted && investmentAllowed;
}