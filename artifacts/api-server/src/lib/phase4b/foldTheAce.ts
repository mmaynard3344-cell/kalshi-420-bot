/**
 * Frozen, outcome-blind preregistration contract for Fold the Ace v1.
 * This module deliberately has no database, settlement, order, auth, route, or
 * submission imports. It classifies only facts observable at the baseline tick.
 */
import type { Phase4BSide } from "./types.js";

export const FOLD_THE_ACE_VERSION = "fold-the-ace-preregistration-v1" as const;
export const FOLD_THE_ACE_RATIO_THRESHOLD = 1.0;
export const FOLD_THE_ACE_ZERO_MOVEMENT_DOLLARS = 0.01;
export const FOLD_THE_ACE_EROSION_THRESHOLD_FRACTION = 0.0005;
export const FOLD_THE_ACE_ANCHOR_TARGET_MS = 30_000;
export const FOLD_THE_ACE_ANCHOR_TOLERANCE_MS = 5_000;
/** Eastern market calendar, fixed so "seven calendar days" is DST-safe. */
export const FOLD_THE_ACE_CALENDAR_TIME_ZONE = "America/New_York";
export const FOLD_THE_ACE_PRIMARY_PRICE_BANDS = [[90, 92], [93, 95]] as const;
export const FOLD_THE_ACE_TIME_BUCKETS = [[1, 30], [31, 60], [61, 120], [121, 180]] as const;
export const FOLD_THE_ACE_SPREAD_BUCKETS = [[0, 2], [3, 5], [6, Infinity]] as const;

export type FoldTheAceStatus = "exposed" | "unexposed" | "unavailable";
export type FoldTheAceAsset = "BTC" | "ETH";

export interface FoldTheAceCandidate {
  snapshotId: string;
  /** Provenance from Phase 4B: only scheduled five-second baselines are eligible. */
  observationKind: "baseline" | "event";
  marketId: string;
  asset: FoldTheAceAsset;
  side: Phase4BSide;
  capturedAtMs: number;
  secondsLeft: number;
  selectedEntryPriceCents: number | null;
  selectedSpreadCents: number | null;
  threshold: number | null;
  comparisonOperator: ">=" | ">" | "<=" | "<" | null;
  referencePrice: number | null;
  referenceSourceTimestampMs: number | null;
  anchor30Price: number | null;
  anchor30SourceTimestampMs: number | null;
}

export interface FoldTheAceClassification {
  signedCushionDollars: number | null;
  proxyMovement30sDollars: number | null;
  selectedSideCushionChange30sDollars: number | null;
  cushionOverMovement30s: number | null;
  h1: FoldTheAceStatus;
  h2: FoldTheAceStatus;
  unavailableReason: string | null;
}

export interface FoldTheAceMatch {
  exposedSnapshotId: string;
  controlSnapshotId: string;
  hypothesis: "H1" | "H2";
}

function inRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

function bandIndex(value: number | null, bands: readonly (readonly [number, number])[]): number | null {
  if (value == null) return null;
  return bands.findIndex((range) => inRange(value, range));
}

function isValidBandIndex(index: number | null): index is number {
  return index != null && index >= 0;
}

function calendarDayNumber(timestampMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: FOLD_THE_ACE_CALENDAR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const lookup = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Date.UTC(Number(lookup.year), Number(lookup.month) - 1, Number(lookup.day)) / 86_400_000;
}

function withinSevenCalendarDays(aTimestampMs: number, bTimestampMs: number): boolean {
  return Math.abs(calendarDayNumber(aTimestampMs) - calendarDayNumber(bTimestampMs)) <= 7;
}

export function isFoldTheAcePrimaryCandidate(candidate: FoldTheAceCandidate): boolean {
  return candidate.selectedEntryPriceCents != null
    && candidate.secondsLeft >= 1
    && candidate.secondsLeft <= 120
    && isValidBandIndex(bandIndex(candidate.selectedEntryPriceCents, FOLD_THE_ACE_PRIMARY_PRICE_BANDS));
}

export function classifyFoldTheAce(candidate: FoldTheAceCandidate): FoldTheAceClassification {
  if (
    candidate.threshold == null || candidate.threshold <= 0 || candidate.comparisonOperator == null ||
    candidate.referencePrice == null || candidate.referenceSourceTimestampMs == null ||
    candidate.referenceSourceTimestampMs > candidate.capturedAtMs ||
    candidate.anchor30Price == null || candidate.anchor30SourceTimestampMs == null
  ) {
    return unavailable();
  }
  const earliestAllowedAnchor = candidate.capturedAtMs - FOLD_THE_ACE_ANCHOR_TARGET_MS - FOLD_THE_ACE_ANCHOR_TOLERANCE_MS;
  const latestAllowedAnchor = candidate.capturedAtMs - FOLD_THE_ACE_ANCHOR_TARGET_MS;
  if (candidate.anchor30SourceTimestampMs < earliestAllowedAnchor || candidate.anchor30SourceTimestampMs > latestAllowedAnchor) {
    return unavailable();
  }
  const signedCushionDollars = candidate.side === "yes"
    ? candidate.referencePrice - candidate.threshold
    : candidate.threshold - candidate.referencePrice;
  const proxyMovement30sDollars = candidate.referencePrice - candidate.anchor30Price;
  const selectedSideCushionChange30sDollars = candidate.side === "yes"
    ? proxyMovement30sDollars
    : -proxyMovement30sDollars;
  const absoluteMovement = Math.abs(proxyMovement30sDollars);
  const cushionOverMovement30s = absoluteMovement > FOLD_THE_ACE_ZERO_MOVEMENT_DOLLARS
    ? signedCushionDollars / absoluteMovement
    : null;
  const h1: FoldTheAceStatus = signedCushionDollars <= 0
    ? "exposed"
    : absoluteMovement <= FOLD_THE_ACE_ZERO_MOVEMENT_DOLLARS
      ? "unexposed"
      : cushionOverMovement30s! < FOLD_THE_ACE_RATIO_THRESHOLD ? "exposed" : "unexposed";
  const h2: FoldTheAceStatus = signedCushionDollars > 0
    && selectedSideCushionChange30sDollars <= -FOLD_THE_ACE_EROSION_THRESHOLD_FRACTION * candidate.threshold
    ? "exposed" : "unexposed";
  return { signedCushionDollars, proxyMovement30sDollars, selectedSideCushionChange30sDollars, cushionOverMovement30s, h1, h2, unavailableReason: null };
}

function unavailable(): FoldTheAceClassification {
  return {
    signedCushionDollars: null, proxyMovement30sDollars: null, selectedSideCushionChange30sDollars: null,
    cushionOverMovement30s: null, h1: "unavailable", h2: "unavailable",
    unavailableReason: "required_timestamp_safe_threshold_or_30s_anchor_unavailable",
  };
}

/**
 * One state per market-side-window: select the earliest in-band baseline first,
 * then classify it. Unavailable evidence must not cause a later replacement.
 */
export function selectFoldTheAceRepresentatives(candidates: readonly FoldTheAceCandidate[]): readonly FoldTheAceCandidate[] {
  const firstByMarketSide = new Map<string, FoldTheAceCandidate>();
  for (const candidate of [...candidates].sort((a, b) =>
    a.capturedAtMs - b.capturedAtMs || a.snapshotId.localeCompare(b.snapshotId))) {
    if (candidate.observationKind !== "baseline" || !isFoldTheAcePrimaryCandidate(candidate)) continue;
    const key = `${candidate.marketId}:${candidate.side}`;
    if (!firstByMarketSide.has(key)) firstByMarketSide.set(key, candidate);
  }
  return [...firstByMarketSide.values()].sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.snapshotId.localeCompare(b.snapshotId));
}

function sameMatchStratum(a: FoldTheAceCandidate, b: FoldTheAceCandidate): boolean {
  const priceA = bandIndex(a.selectedEntryPriceCents, FOLD_THE_ACE_PRIMARY_PRICE_BANDS);
  const priceB = bandIndex(b.selectedEntryPriceCents, FOLD_THE_ACE_PRIMARY_PRICE_BANDS);
  const timeA = bandIndex(a.secondsLeft, FOLD_THE_ACE_TIME_BUCKETS);
  const timeB = bandIndex(b.secondsLeft, FOLD_THE_ACE_TIME_BUCKETS);
  const spreadA = bandIndex(a.selectedSpreadCents, FOLD_THE_ACE_SPREAD_BUCKETS);
  const spreadB = bandIndex(b.selectedSpreadCents, FOLD_THE_ACE_SPREAD_BUCKETS);
  return a.asset === b.asset && a.side === b.side
    && isValidBandIndex(priceA) && priceA === priceB
    && isValidBandIndex(timeA) && timeA === timeB
    && isValidBandIndex(spreadA) && spreadA === spreadB;
}

/** Outcome-blind, without-replacement nearest-neighbor matching frozen in v1. */
export function matchFoldTheAce(
  candidates: readonly FoldTheAceCandidate[],
  hypothesis: "H1" | "H2",
): readonly FoldTheAceMatch[] {
  const representatives = selectFoldTheAceRepresentatives(candidates);
  const classifications = new Map(representatives.map((candidate) => [candidate.snapshotId, classifyFoldTheAce(candidate)]));
  const usedControls = new Set<string>();
  const exposed = representatives.filter((candidate) => classifications.get(candidate.snapshotId)?.[hypothesis.toLowerCase() as "h1" | "h2"] === "exposed")
    .sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.snapshotId.localeCompare(b.snapshotId));
  const matches: FoldTheAceMatch[] = [];
  for (const candidate of exposed) {
    const control = representatives
      .filter((possible) => !usedControls.has(possible.snapshotId)
        && classifications.get(possible.snapshotId)?.[hypothesis.toLowerCase() as "h1" | "h2"] === "unexposed"
        && sameMatchStratum(candidate, possible)
        && Math.abs((candidate.selectedEntryPriceCents ?? Infinity) - (possible.selectedEntryPriceCents ?? -Infinity)) <= 1
        && Math.abs(candidate.secondsLeft - possible.secondsLeft) <= 10
        && withinSevenCalendarDays(candidate.capturedAtMs, possible.capturedAtMs))
      .sort((a, b) =>
        Math.abs(candidate.secondsLeft - a.secondsLeft) - Math.abs(candidate.secondsLeft - b.secondsLeft)
        || Math.abs((candidate.selectedEntryPriceCents ?? 0) - (a.selectedEntryPriceCents ?? 0))
          - Math.abs((candidate.selectedEntryPriceCents ?? 0) - (b.selectedEntryPriceCents ?? 0))
        || Math.abs(candidate.capturedAtMs - a.capturedAtMs) - Math.abs(candidate.capturedAtMs - b.capturedAtMs)
        || a.snapshotId.localeCompare(b.snapshotId))[0];
    if (!control) continue;
    usedControls.add(control.snapshotId);
    matches.push({ exposedSnapshotId: candidate.snapshotId, controlSnapshotId: control.snapshotId, hypothesis });
  }
  return matches;
}