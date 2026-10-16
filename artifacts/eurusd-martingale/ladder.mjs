// Pure USD martingale transition rules. No market access, order submission, or production writes.
export const USD_STAKES_CENTS = Object.freeze([100,200,400,800,1600,3200]);
export function nextUsdStep(step, outcome) {
  if (!Number.isInteger(step) || step < 0 || step >= USD_STAKES_CENTS.length) throw Error("invalid_step");
  if (outcome === "WIN") return 0;
  if (outcome === "LOSS") return (step + 1) % USD_STAKES_CENTS.length;
  if (outcome === "ZERO_FILL") return step;
  throw Error("unverified_outcome");
}
export function classifyUsdSettlement({filledContracts, orderStatus, marketResult, side}) {
  if (!Number.isFinite(filledContracts) || filledContracts < 0) return "UNRESOLVED";
  if (filledContracts === 0) return ["canceled","cancelled","expired","rejected"].includes(String(orderStatus).toLowerCase()) ? "ZERO_FILL" : "UNRESOLVED";
  if (!["yes","no"].includes(marketResult) || !["YES","NO"].includes(side)) return "UNRESOLVED";
  return marketResult === side.toLowerCase() ? "WIN" : "LOSS";
}
export function stakeForUsdStep(step) {
  if (!Number.isInteger(step) || step < 0 || step >= USD_STAKES_CENTS.length) throw Error("invalid_step");
  return USD_STAKES_CENTS[step];
}
