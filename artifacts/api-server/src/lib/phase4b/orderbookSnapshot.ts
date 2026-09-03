import { computeSnapshotFields, parseOrderbookResponse, type KalshiOrderbookRaw } from "../orderbookParsing.js";
import type { Phase4BBookSnapshot, Phase4BLevel, Phase4BSide } from "./types.js";
import { PHASE4B_MAX_LEVELS, PHASE4B_SCHEMA_VERSION } from "./types.js";

function valid(level: Phase4BLevel): boolean {
  return Number.isInteger(level.priceCents) && level.priceCents > 0 && level.priceCents < 100
    && Number.isFinite(level.contracts) && level.contracts >= 0
    && Number.isFinite(level.notionalDollars) && level.notionalDollars >= 0;
}

export function normalizePhase4BBook(
  raw: KalshiOrderbookRaw,
  side: Phase4BSide,
  snapshotId: string,
  limitCents: number | null,
  fetchedAtMs: number,
  fetchLatencyMs: number,
  fetchError: string | null = null,
): Phase4BBookSnapshot {
  const parsed = fetchError ? [] : parseOrderbookResponse(raw, side);
  const all = parsed
    .map((level) => ({ priceCents: level.priceCents, contracts: level.contractsApprox, notionalDollars: level.notionalDollars }))
    .filter(valid)
    .sort((a, b) => a.priceCents - b.priceCents);
  const levels = all.slice(0, PHASE4B_MAX_LEVELS);
  const executable = limitCents != null && Number.isInteger(limitCents)
    ? computeSnapshotFields(parsed, limitCents)
    : { depthAtOrBetterContracts: 0, depthAtOrBetterDollars: 0 };
  const bestAskCents = levels[0]?.priceCents ?? null;
  const bestBidCents = null;
  return {
    snapshotId, side, fetchedAtMs, fetchLatencyMs, fetchError,
    bestBidCents, bestAskCents,
    spreadCents: bestBidCents != null && bestAskCents != null ? bestAskCents - bestBidCents : null,
    levels: levels.map((level) => ({ ...level })),
    totalRetainedContracts: levels.reduce((sum, level) => sum + level.contracts, 0),
    totalRetainedNotionalDollars: levels.reduce((sum, level) => sum + level.notionalDollars, 0),
    executableContracts: executable.depthAtOrBetterContracts,
    executableNotionalDollars: executable.depthAtOrBetterDollars,
    schemaVersion: PHASE4B_SCHEMA_VERSION,
  };
}