/** Pure direction rule for ETH G's exact-two streak reversal. */
export type GSide = "yes" | "no";

export function ethGReversalSide(older: GSide, previous: GSide, latest: GSide): GSide | null {
  // A newly formed two-outcome streak, not a three-or-more streak.
  if (previous !== latest || older === latest) return null;
  return latest === "yes" ? "no" : "yes";
}
