from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts"
source = path.read_text()

old_helper = '''/** Whole-contract retained-side IOC quantity that never exceeds the $420 Back Flip risk cap. */
export function eth420BackFlipIocContracts(chosenSideAskCents: number): number | null {
  if (!Number.isInteger(chosenSideAskCents) || chosenSideAskCents < 1 || chosenSideAskCents > 99) return null;
  const contracts = Math.floor(ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS / chosenSideAskCents);
  return contracts >= 1 ? contracts : null;
}'''
new_helper = '''/** The retained-side Back Flip is intentionally marketable across the valid book. */
export const ETH_420_BACK_FLIP_IOC_LIMIT_PRICE_CENTS = 99;
/** Whole-contract IOC quantity that cannot exceed the $420 cap even if every fill occurs at 99¢. */
export function eth420BackFlipIocContracts(chosenSideAskCents: number): number | null {
  if (!Number.isInteger(chosenSideAskCents) || chosenSideAskCents < 1 || chosenSideAskCents > 99) return null;
  const contracts = Math.floor(ETH_420_BACK_FLIP_RETAIN_WAGER_CENTS / ETH_420_BACK_FLIP_IOC_LIMIT_PRICE_CENTS);
  return contracts >= 1 ? contracts : null;
}'''
if source.count(old_helper) != 1:
    raise SystemExit(f"backflip IOC helper replacement count={source.count(old_helper)}")
source = source.replace(old_helper, new_helper)

old_arm = '''  let backFlip = Number.isInteger(openTimeMs) && store.getEth420CandidateBackFlipArm
    ? await store.getEth420CandidateBackFlipArm(openTimeMs!) : null;
  if (backFlip) {'''
new_arm = '''  let backFlip = Number.isInteger(openTimeMs) && store.getEth420CandidateBackFlipArm
    ? await store.getEth420CandidateBackFlipArm(openTimeMs!) : null;
  // Back Flip is a one-window handoff from Regular only. Candidate/Back-Flip
  // zero fills must never recursively arm another Back Flip.
  if (backFlip && !String(backFlip.sourceCandidateOrderId).startsWith("regular:")) {
    note("back_flip_ignored", "non_regular_back_flip_source");
    backFlip = null;
  }
  if (backFlip) {'''
if source.count(old_arm) != 1:
    raise SystemExit(f"backflip arm eligibility replacement count={source.count(old_arm)}")
source = source.replace(old_arm, new_arm)

old_limit = '''        executionMode: crossesAsk ? "cross_ioc" : "resting_gtc",
        limitPriceCents: crossesAsk ? chosenAsk! : ETH_420_LIVE_LIMIT_PRICE_CENTS });'''
new_limit = '''        executionMode: crossesAsk ? "cross_ioc" : "resting_gtc",
        limitPriceCents: crossesAsk ? ETH_420_BACK_FLIP_IOC_LIMIT_PRICE_CENTS : ETH_420_LIVE_LIMIT_PRICE_CENTS });'''
if source.count(old_limit) != 1:
    raise SystemExit(f"backflip IOC limit replacement count={source.count(old_limit)}")
source = source.replace(old_limit, new_limit)

path.write_text(source)
