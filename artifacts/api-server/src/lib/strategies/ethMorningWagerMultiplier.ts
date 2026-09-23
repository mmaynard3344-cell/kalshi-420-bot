/**
 * Time-of-day sizing disabled.
 * Preserve the call site/API so service behavior remains otherwise unchanged.
 */
export function applyEthMorningWagerMultiplier(baseCents: number, _atMs = Date.now()): number {
  return baseCents;
}
