import {
  A2_BASELINE_REVERSION_STRATEGY_ID,
  A2_FIXED_STAKE_CENTS,
  A2_MAX_ENTRY_PRICE_CENTS,
  evaluateA2BaselineReversion,
  type A2BaselineReversionConfig,
  type A2BtcCandle,
  type A2DestinationMarket,
} from "./a2BaselineReversion.js";
import type {
  A2ShadowClaimOutcome,
  A2ShadowStore,
} from "./a2BaselineReversionShadowStore.js";

export type A2ShadowEvaluationOutcome =
  | "disabled"
  | "no_signal"
  | "shadow_opened"
  | "duplicate"
  | "active_exposure_limit"
  | "store_unavailable";

export interface A2ShadowEvaluationResult {
  outcome: A2ShadowEvaluationOutcome;
  signal: boolean;
  reason: string | null;
  claimId: string | null;
}

export function a2ShadowClaimId(sourceOpenTimeMs: number, destinationTicker: string): string {
  return `a2:${sourceOpenTimeMs}:${destinationTicker}`;
}

export function a2EvidenceId(input: {
  sourceOpenTimeMs: number;
  destinationTicker: string;
  observedAtMs: number;
}): string {
  return `a2-evidence:${input.sourceOpenTimeMs}:${input.destinationTicker}:${input.observedAtMs}`;
}

export async function evaluateA2BaselineReversionShadow(input: {
  config: A2BaselineReversionConfig;
  source: A2BtcCandle;
  destination: A2DestinationMarket;
  observedAtMs: number;
  store: A2ShadowStore;
}): Promise<A2ShadowEvaluationResult> {
  if (!input.config.enabled) {
    return { outcome: "disabled", signal: false, reason: "disabled", claimId: null };
  }

  const openCount = await input.store.countOpen();
  if (openCount == null) {
    return { outcome: "store_unavailable", signal: false, reason: "store_unavailable", claimId: null };
  }

  const decision = evaluateA2BaselineReversion({
    config: input.config,
    source: input.source,
    destination: input.destination,
    activeA2ExposureCount: openCount,
  });
  const sourceDropFraction = input.source.open > 0
    ? (input.source.open - input.source.close) / input.source.open
    : null;

  await input.store.recordEvidence({
    id: a2EvidenceId({
      sourceOpenTimeMs: input.source.openTimeMs,
      destinationTicker: input.destination.ticker,
      observedAtMs: input.observedAtMs,
    }),
    observedAtMs: input.observedAtMs,
    sourceOpenTimeMs: input.source.openTimeMs,
    sourceCloseTimeMs: input.source.closeTimeMs,
    sourceOpen: input.source.open,
    sourceHigh: input.source.high,
    sourceLow: input.source.low,
    sourceClose: input.source.close,
    sourceDropFraction: Number.isFinite(sourceDropFraction) ? sourceDropFraction : null,
    destinationTicker: input.destination.ticker,
    destinationOpenTimeMs: input.destination.openTimeMs,
    destinationCloseTimeMs: input.destination.closeTimeMs,
    yesSemanticsVerified: input.destination.yesSettlesAboveStrike,
    observedYesAskCents: input.destination.yesAskCents,
    signal: decision.signal,
    reason: decision.signal ? null : decision.reason,
    stakeCents: A2_FIXED_STAKE_CENTS,
    maxEntryPriceCents: A2_MAX_ENTRY_PRICE_CENTS,
    activeExposureCountObserved: openCount,
  });

  if (!decision.signal) {
    return {
      outcome: decision.reason === "active_exposure_limit" ? "active_exposure_limit" : "no_signal",
      signal: false,
      reason: decision.reason,
      claimId: null,
    };
  }

  const claimId = a2ShadowClaimId(input.source.openTimeMs, input.destination.ticker);
  const claimOutcome: A2ShadowClaimOutcome = await input.store.claimOpen({
    id: claimId,
    strategyId: A2_BASELINE_REVERSION_STRATEGY_ID,
    sourceOpenTimeMs: input.source.openTimeMs,
    sourceCloseTimeMs: input.source.closeTimeMs,
    destinationTicker: input.destination.ticker,
    destinationOpenTimeMs: input.destination.openTimeMs,
    side: "yes",
    stakeCents: A2_FIXED_STAKE_CENTS,
    maxEntryPriceCents: A2_MAX_ENTRY_PRICE_CENTS,
    observedYesAskCents: input.destination.yesAskCents!,
    sourceDropFraction: decision.sourceDropFraction,
    claimedAtMs: input.observedAtMs,
  });

  const outcome: A2ShadowEvaluationOutcome =
    claimOutcome === "opened" ? "shadow_opened"
      : claimOutcome;

  return {
    outcome,
    signal: claimOutcome === "opened",
    reason: claimOutcome === "opened" ? null : claimOutcome,
    claimId: claimOutcome === "opened" || claimOutcome === "duplicate" ? claimId : null,
  };
}
