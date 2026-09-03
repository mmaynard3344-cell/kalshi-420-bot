/**
 * Passive ETH420 runaway classification from retained execution evidence.
 * This module has no exchange, executor, reservation, settlement, or state
 * dependencies; it can only read diagnostic inputs and upsert research rows.
 */
import type { Eth420CandidateExecutionSnapshot, Eth420CandidateLiveOrder } from "./tradeStore.js";

export const ETH420_RUNAWAY_CLASSIFIER_VERSION = "v1";
const EARLY_OFFSETS = [1_000, 2_000, 5_000] as const;
const REQUIRED_QUIET_OFFSETS = [1_000, 2_000, 5_000, 10_000] as const;

export type Eth420RunawayResearchInput = {
  order: Eth420CandidateLiveOrder;
  snapshots: Eth420CandidateExecutionSnapshot[];
};

export type Eth420RunawayResearchRecord = {
  candidateOrderId: string;
  ticker: string;
  selectedSide: "yes" | "no";
  requestedContracts: number;
  classifierVersion: string;
  alreadyGoneFired: boolean;
  acceleratingRunawayFired: boolean;
  quietRunawayFired: boolean;
  firedRegimes: Array<"already_gone" | "accelerating_runaway" | "quiet_runaway">;
  decisionPointOffsetMs: number | null;
  hypotheticalFullSizeEntryPriceCents: number | null;
  sourceSnapshotsJson: string;
  settlementResult: "yes" | "no" | null;
  hypotheticalEntryCostCents: number | null;
  hypotheticalFeeCents: number | null;
  hypotheticalGrossPnlCents: number | null;
  hypotheticalNetPnlCents: number | null;
  sourceUpdatedAtMs: number;
};

export interface Eth420RunawayResearchStore {
  listEth420CandidateRunawayResearchInputs(limit: number): Promise<Eth420RunawayResearchInput[]>;
  recordEth420CandidateRunawayResearch(record: Eth420RunawayResearchRecord): Promise<boolean>;
}

function capturedByOffset(snapshots: Eth420CandidateExecutionSnapshot[]): Map<number, Eth420CandidateExecutionSnapshot> {
  return new Map(snapshots
    .filter((snapshot) => snapshot.observationState === "captured")
    .sort((a, b) => a.scheduledOffsetMs - b.scheduledOffsetMs)
    .map((snapshot) => [snapshot.scheduledOffsetMs, snapshot]));
}

function sourceSnapshot(snapshot: Eth420CandidateExecutionSnapshot | undefined): Record<string, unknown> | null {
  if (!snapshot) return null;
  return {
    scheduledOffsetMs: snapshot.scheduledOffsetMs,
    scheduledAtMs: snapshot.scheduledAtMs,
    observedAtMs: snapshot.observedAtMs,
    orderStatus: snapshot.orderStatus,
    filledContracts: snapshot.filledContracts,
    selectedBestBidCents: snapshot.selectedBestBidCents,
    selectedBestAskCents: snapshot.selectedBestAskCents,
    depthAt50Contracts: snapshot.depthAt50Contracts,
    fullSizeExecutablePriceCents: snapshot.fullSizeExecutablePriceCents,
    observationState: snapshot.observationState,
  };
}

function isRestingWithZero(snapshot: Eth420CandidateExecutionSnapshot | undefined): boolean {
  return snapshot?.orderStatus === "resting" && snapshot.filledContracts === 0;
}

function estimateEntryFeeCents(contracts: number, priceCents: number): number {
  return Math.ceil(0.07 * contracts * priceCents * (100 - priceCents) / 100);
}

/** Pure classifier. It intentionally has no side effects and no state inputs. */
export function classifyEth420Runaway(input: Eth420RunawayResearchInput): Eth420RunawayResearchRecord {
  const { order } = input;
  const byOffset = capturedByOffset(input.snapshots);
  const early = EARLY_OFFSETS.map((offset) => byOffset.get(offset));
  const plus1 = byOffset.get(1_000);
  const plus10 = byOffset.get(10_000);
  const earlyTrigger = early.find((snapshot) => snapshot != null && isRestingWithZero(snapshot)
    && (snapshot.selectedBestAskCents ?? -1) >= 90);
  const alreadyGoneFired = earlyTrigger != null;
  const acceleratingRunawayFired = isRestingWithZero(plus10)
    && (plus10?.selectedBestAskCents ?? Infinity) >= 62
    && plus1?.selectedBestAskCents != null
    && plus10?.selectedBestAskCents != null
    && plus10.selectedBestAskCents - plus1.selectedBestAskCents >= 3
    && (plus10.fullSizeExecutablePriceCents ?? Infinity) <= 70;
  const quietSnapshots = REQUIRED_QUIET_OFFSETS.map((offset) => byOffset.get(offset));
  const quietAsks = quietSnapshots.map((snapshot) => snapshot?.selectedBestAskCents);
  const quietRunawayFired = isRestingWithZero(plus10)
    && plus1?.selectedBestAskCents != null
    && plus1.selectedBestAskCents >= 53 && plus1.selectedBestAskCents <= 60
    && quietAsks.every((ask): ask is number => ask != null && Math.abs(ask - plus1.selectedBestAskCents!) <= 2)
    && plus1.selectedBestBidCents != null && plus10?.selectedBestBidCents != null
    && plus10.selectedBestBidCents > plus1.selectedBestBidCents
    && plus1.fullSizeExecutablePriceCents != null && plus10?.fullSizeExecutablePriceCents != null
    && plus10.fullSizeExecutablePriceCents > plus1.fullSizeExecutablePriceCents;
  const firedRegimes: Eth420RunawayResearchRecord["firedRegimes"] = [
    ...(alreadyGoneFired ? ["already_gone" as const] : []),
    ...(acceleratingRunawayFired ? ["accelerating_runaway" as const] : []),
    ...(quietRunawayFired ? ["quiet_runaway" as const] : []),
  ];
  const decisionSnapshot = earlyTrigger ?? ((acceleratingRunawayFired || quietRunawayFired) ? plus10 : undefined);
  const entryPrice = decisionSnapshot?.fullSizeExecutablePriceCents ?? null;
  const settled = order.settlementResult != null && entryPrice != null;
  const cost = settled ? order.requestedContracts * entryPrice : null;
  const fee = cost == null || entryPrice == null ? null : estimateEntryFeeCents(order.requestedContracts, entryPrice);
  const grossPnl = cost == null ? null : order.settlementResult === order.side
    ? order.requestedContracts * (100 - entryPrice!)
    : -cost;
  const sourceValues = {
    t: sourceSnapshot(byOffset.get(0)),
    plus1s: sourceSnapshot(plus1),
    plus2s: sourceSnapshot(byOffset.get(2_000)),
    plus5s: sourceSnapshot(byOffset.get(5_000)),
    plus10s: sourceSnapshot(plus10),
    triggerOffsetMs: decisionSnapshot?.scheduledOffsetMs ?? null,
  };
  return {
    candidateOrderId: order.id, ticker: order.ticker, selectedSide: order.side,
    requestedContracts: order.requestedContracts, classifierVersion: ETH420_RUNAWAY_CLASSIFIER_VERSION,
    alreadyGoneFired, acceleratingRunawayFired, quietRunawayFired, firedRegimes,
    decisionPointOffsetMs: decisionSnapshot?.scheduledOffsetMs ?? null,
    hypotheticalFullSizeEntryPriceCents: entryPrice, sourceSnapshotsJson: JSON.stringify(sourceValues),
    settlementResult: order.settlementResult, hypotheticalEntryCostCents: cost, hypotheticalFeeCents: fee,
    hypotheticalGrossPnlCents: grossPnl, hypotheticalNetPnlCents: grossPnl == null || fee == null ? null : grossPnl - fee,
    sourceUpdatedAtMs: Math.max(order.updatedAtMs, ...input.snapshots.map((snapshot) => snapshot.observedAtMs)),
  };
}

let refreshInFlight = false;

/** Refreshes only passive research rows; failures are intentionally non-blocking. */
export async function refreshEth420RunawayResearch(store: Eth420RunawayResearchStore, limit = 2_000): Promise<number> {
  if (refreshInFlight) return 0;
  refreshInFlight = true;
  try {
    const inputs = await store.listEth420CandidateRunawayResearchInputs(Math.max(1, Math.min(2_000, limit)));
    let persisted = 0;
    for (const input of inputs) {
      if (await store.recordEth420CandidateRunawayResearch(classifyEth420Runaway(input))) persisted += 1;
    }
    return persisted;
  } finally {
    refreshInFlight = false;
  }
}