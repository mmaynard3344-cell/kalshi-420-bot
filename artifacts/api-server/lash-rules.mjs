export const LASH_LADDER_CENTS = Object.freeze([5_000, 10_000, 20_000]);
export const LASH_LIMIT_CENTS = 50;

export function normalizeOutcome(value) {
  const outcome = typeof value === "string" ? value.toUpperCase() : null;
  return outcome === "YES" || outcome === "NO" ? outcome : null;
}

export function opposite(side) {
  const normalized = normalizeOutcome(side);
  if (!normalized) throw new Error("side must be YES or NO");
  return normalized === "YES" ? "NO" : "YES";
}

export function signalFromFinalized(markets) {
  if (!Array.isArray(markets) || markets.length < 2) return null;
  const previous = markets.at(-2);
  const latest = markets.at(-1);
  const previousResult = normalizeOutcome(previous?.result);
  const latestResult = normalizeOutcome(latest?.result);
  if (!previousResult || previousResult !== latestResult) return null;
  if (previous?.status !== "finalized" || latest?.status !== "finalized") return null;
  return {
    side: opposite(latestResult),
    streakSide: latestResult,
    signalTicker: latest.ticker,
  };
}

export function principalForStep(step) {
  if (!Number.isInteger(step) || step < 0 || step >= LASH_LADDER_CENTS.length) {
    throw new Error("invalid Lash step");
  }
  return LASH_LADDER_CENTS[step];
}

export function contractsForStep(step) {
  return Math.floor(principalForStep(step) / LASH_LIMIT_CENTS);
}

export function transition({ step, side }, settlement) {
  principalForStep(step);
  const normalizedSide = normalizeOutcome(side);
  if (!normalizedSide) throw new Error("invalid Lash side");
  const filledContracts = Number(settlement?.filledContracts ?? 0);
  if (!Number.isFinite(filledContracts) || filledContracts < 0) {
    throw new Error("invalid fill quantity");
  }
  if (filledContracts === 0) {
    return { step, side: normalizedSide, active: true, reason: "zero_fill_neutral" };
  }
  const result = normalizeOutcome(settlement?.officialResult);
  if (!result) throw new Error("official finalized result required");
  if (result === normalizedSide) {
    return { step: 0, side: null, active: false, reason: "win_reset" };
  }
  if (step < LASH_LADDER_CENTS.length - 1) {
    return { step: step + 1, side: normalizedSide, active: true, reason: "loss_advance" };
  }
  return { step: 0, side: null, active: false, reason: "step_three_loss_reset" };
}

export function restingIntent({ targetTicker, signalTicker, side, step }) {
  const normalizedSide = normalizeOutcome(side);
  if (!targetTicker || !signalTicker || !normalizedSide) throw new Error("incomplete Lash intent");
  return Object.freeze({
    strategy: "LASH_L",
    targetTicker,
    signalTicker,
    side: normalizedSide,
    step,
    principalCents: principalForStep(step),
    contracts: contractsForStep(step),
    limitPriceCents: LASH_LIMIT_CENTS,
    timeInForce: "good_till_canceled",
    resting: true,
    executable: false,
  });
}
