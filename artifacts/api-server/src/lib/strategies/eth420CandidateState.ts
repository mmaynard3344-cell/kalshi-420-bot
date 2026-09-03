/** Pure, orderless ETH 420 sequence transition shared by shadow capture and SQL settlement. */
export function advanceEth420CandidateSequence(
  state: { side: "yes" | "no"; step: number },
  result: "yes" | "no",
): { side: "yes" | "no"; step: number } {
  if (result === state.side) return { side: state.side === "yes" ? "no" : "yes", step: 0 };
  return { side: state.side, step: state.step >= 5 ? 0 : state.step + 1 };
}