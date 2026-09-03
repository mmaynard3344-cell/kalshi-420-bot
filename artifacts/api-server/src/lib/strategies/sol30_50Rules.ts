/** Dependency-free SOL_30_50 eligibility and arithmetic rules. */
export const SOL30_STRATEGY_ID = "SOL_30_50" as const;
export const SOL30_ENTRY_CAP_CENTS = 30;
export const SOL30_TARGET_CENTS = 50;
export const SOL30_WINDOW_MS = 5 * 60_000;
export const SOL30_PRINCIPAL_CAP_CENTS = 100;
export { PAIRED30_SIDE_PRINCIPAL_CAP_CENTS, PAIRED30_MARKET_PRINCIPAL_CAP_CENTS, planPaired30Entry } from "./paired30_50Rules.js";

export function isSol30Ticker(ticker: string): boolean {
  return ticker.split("-", 1)[0] === "KXSOL15M";
}
export function isSol30OpeningWindow(openTime: string | null, nowMs = Date.now()): boolean {
  if (!openTime) return false;
  const opened = new Date(openTime).getTime();
  return Number.isFinite(opened) && nowMs >= opened && nowMs < opened + SOL30_WINDOW_MS;
}
export function contractsForSol30Capacity(remainingCents: number, executableCents: number, depth: number): number {
  if (!Number.isInteger(executableCents) || executableCents < 20 || executableCents > SOL30_ENTRY_CAP_CENTS) return 0;
  const cappedPrincipal = Math.min(Math.max(0, Math.floor(remainingCents)), SOL30_PRINCIPAL_CAP_CENTS);
  return Math.max(0, Math.min(Math.floor(cappedPrincipal / executableCents), Math.floor(depth)));
}

/** Explicit pure boundary for the feature flag, global halt, and profit stop. */
export function mayEnterSol30(enabled: boolean, globallyHalted: boolean, investmentAllowed: boolean): boolean {
  return enabled && !globallyHalted && investmentAllowed;
}
