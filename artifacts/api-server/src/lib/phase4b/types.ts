/**
 * Phase 4B immutable passive-capture types.
 * This module is intentionally free of live order, route, auth, and strategy imports.
 */

export const PHASE4B_SCHEMA_VERSION = "2";
export const PHASE4B_MAX_QUEUE = 256;
export const PHASE4B_MAX_LEVELS = 10;

export type Phase4BSide = "yes" | "no";
export type Phase4BSource = "websocket" | "rest_fallback" | "startup_prime" | "unknown";

/** Raw Kalshi contract metadata observed with a passive quote; never strategy configuration. */
export interface Phase4BThresholdRuleSnapshot {
  captureVersion: "distance-to-beat-prospective-v1";
  source: "kalshi_market_api_snapshot" | "unavailable";
  observedAtMs: number;
  floorStrike: number | null;
  comparisonOperator: ">=" | ">" | "<=" | "<" | null;
  rulesPrimary: string | null;
  rulesSecondary: string | null;
  rulesHash: string | null;
  unavailableReason: string | null;
}
export type Phase4BFinalDecisionClassification =
  | "eligible_for_preflight"
  | "submitted"
  | "rejected_price_floor"
  | "rejected_price_cap"
  | "rejected_stale_bbo_gap"
  | "rejected_wide_spread"
  | "rejected_zero_depth"
  | "rejected_l2_unavailable"
  | "rejected_budget"
  | "rejected_position"
  | "rejected_dedup"
  | "rejected_halted"
  | "rejected_other";

/**
 * Each value is a passive observation of the equivalent live guard at the
 * captured boundary.  These fields are deliberately data-only; they never
 * participate in a guard decision or an order request.
 */
export interface Phase4BGuardOutcomes {
  priceFloor: boolean | null;
  priceCap: boolean | null;
  staleBboGap: boolean | null;
  wideSpread: boolean | null;
  l2Available: boolean | null;
  executableDepth: boolean | null;
  budget: boolean | null;
  position: boolean | null;
  dedup: boolean | null;
  halted: boolean | null;
}

export interface Phase4BLevel {
  priceCents: number;
  contracts: number;
  notionalDollars: number;
}

export interface Phase4BMarketInterval {
  marketId: string;
  ticker: string;
  series: string;
  asset: "BTC" | "ETH" | "unknown";
  intervalStartMs: number | null;
  intervalEndMs: number | null;
  windowCloseMs: number;
  metadataCapturedAtMs: number;
  schemaVersion: string;
  metadataVersion: string;
}

export interface Phase4BDecisionSnapshot {
  snapshotId: string;
  marketId: string;
  capturedAtMs: number;
  secondsLeft: number;
  candidateSide: Phase4BSide;
  selectedSideReason: string;
  source: Phase4BSource;
  wsConnected: boolean;
  wsStale: boolean;
  lastWsMessageAgeMs: number | null;
  bboAgeMs: number | null;
  restFallbackActive: boolean;
  restFallbackReason: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  yesDerivedAsk: number | null;
  noDerivedAsk: number | null;
  yesSpreadCents: number | null;
  noSpreadCents: number | null;
  displayedEntryPriceCents: number | null;
  configuredLimitCents: number | null;
  bboDerivedLimitCents: number | null;
  strategyVersion: string | null;
  betDollars: number;
  priceFloorCents: number;
  priceCapCents: number;
  limitBufferCents: number | null;
  staleGapThresholdCents: number | null;
  decisionClassification: string;
  skipReason: string | null;
  quotedBboAskCents: number | null;
  executableL2AskCents: number | null;
  bboToL2GapCents: number | null;
  preflightLatencyMs: number | null;
  finalDecisionClassification: Phase4BFinalDecisionClassification | null;
  finalOrderPathOutcome: string | null;
  guardOutcomes: Phase4BGuardOutcomes | null;
  allOtherGuardsPassed: boolean | null;
  executableL2DepthContracts: number | null;
  intendedContractCount: number | null;
  intendedNotionalCents: number | null;
  availableExposureDollars: number | null;
  estimatedFeesDollars: number | null;
  /** Local attempt correlation ID; passive only, never used to submit an order. */
  clientOrderId: string | null;
  /** Exchange order ID when Kalshi acknowledged the submission. */
  kalshiOrderId: string | null;
  /** Authoritative contract rule metadata as observed at this exact passive capture. */
  thresholdRule?: Phase4BThresholdRuleSnapshot;
  schemaVersion: string;
}

export interface Phase4BBookSnapshot {
  snapshotId: string;
  side: Phase4BSide;
  fetchedAtMs: number;
  fetchLatencyMs: number;
  fetchError: string | null;
  bestBidCents: number | null;
  bestAskCents: number | null;
  spreadCents: number | null;
  levels: readonly Phase4BLevel[];
  totalRetainedContracts: number;
  totalRetainedNotionalDollars: number;
  executableContracts: number;
  executableNotionalDollars: number;
  schemaVersion: string;
}

/**
 * Evidence quality for the causal (at-or-before capture) reference pairing.
 * "live" — the fresh live proxy fetch itself was causal and non-stale.
 * "fresh_prior" / "aged_prior" — a strictly earlier retained point was used;
 * age is recorded explicitly and never hidden. Later or settlement values are
 * never substituted.
 */
export type Phase4BCausalEvidenceStatus = "live" | "fresh_prior" | "aged_prior" | "unavailable";

export interface Phase4BReferenceObservation {
  snapshotId: string;
  asset: "BTC" | "ETH" | "unknown";
  source: string;
  referencePrice: number | null;
  sourceTimestampMs: number | null;
  capturedAtMs: number;
  sourceAgeMs: number | null;
  cacheAgeMs: number | null;
  stale: boolean;
  error: string | null;
  return5s: number | null;
  return15s: number | null;
  return30s: number | null;
  /**
   * Strict Fold-the-Ace causal anchor. Unlike return30s, this is usable only
   * when the latest point at/before T−30s is no more than five seconds old.
   */
  causal30sAnchorPrice: number | null;
  causal30sAnchorSourceTimestampMs: number | null;
  causal30sAnchorStatus: "available" | "missing" | "outside_30s_5s_window" | "reference_unavailable";
  /**
   * Best causal reference observation at or before capturedAtMs. Unlike
   * referencePrice (nulled when the live fetch is stale or failed), these
   * fields retain the latest strictly-causal prior point with its true source
   * timestamp and age, so entry-time distance stays explainable.
   */
  causalReferencePrice: number | null;
  causalReferenceSourceTimestampMs: number | null;
  causalReferenceAgeMs: number | null;
  causalEvidenceStatus: Phase4BCausalEvidenceStatus;
  return60s: number | null;
  return5m: number | null;
  intervalToDateReturn: number | null;
  direction: "up" | "down" | "flat" | null;
  realizedVolatility60s: number | null;
  realizedVolatility5m: number | null;
  acceleration: number | null;
  schemaVersion: string;
}

export interface Phase4BMarketOutcome {
  marketId: string;
  result: Phase4BSide | null;
  settlementTimestampMs: number | null;
  reconciledAtMs: number;
  settlementStatus: string;
  schemaVersion: string;
}

export interface Phase4BCaptureInput {
  timestampMs: number;
  ticker: string;
  series: string;
  closeTime: string;
  openTime?: string | null;
  secondsLeft: number;
  side: Phase4BSide;
  selectedSideReason?: string;
  source: Phase4BSource;
  wsConnected: boolean;
  wsStale: boolean;
  lastWsMessageAgeMs: number | null;
  bboAgeMs: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  displayedEntryPriceCents: number | null;
  configuredLimitCents: number | null;
  bboDerivedLimitCents: number | null;
  strategyVersion: string | null;
  betDollars: number;
  priceFloorCents: number;
  priceCapCents: number;
  limitBufferCents: number | null;
  staleGapThresholdCents: number | null;
  decisionClassification: string;
  skipReason: string | null;
  quotedBboAskCents: number | null;
  executableL2AskCents: number | null;
  bboToL2GapCents: number | null;
  preflightLatencyMs: number | null;
  finalDecisionClassification?: Phase4BFinalDecisionClassification | null;
  finalOrderPathOutcome?: string | null;
  guardOutcomes?: Phase4BGuardOutcomes | null;
  allOtherGuardsPassed?: boolean | null;
  executableL2DepthContracts?: number | null;
  intendedContractCount?: number | null;
  intendedNotionalCents?: number | null;
  availableExposureDollars?: number | null;
  estimatedFeesDollars?: number | null;
  clientOrderId?: string | null;
  kalshiOrderId?: string | null;
  thresholdRule?: Phase4BThresholdRuleSnapshot;
}

/** Immutable passive observation, not a signal, recommendation, or fill simulation. */
export interface Phase4BProspectiveSimulationRecord {
  id: string;
  snapshotId: string;
  hypothesisVersion: "no-70-76-positive-valid-return30s-v1";
  qualification: "qualified" | "not_qualified";
  reason: string;
  ticker: string;
  side: Phase4BSide;
  candidateEntryPriceCents: number | null;
  referenceReturn30s: number | null;
  referenceStale: boolean;
  capturedAtMs: number;
  schemaVersion: string;
}

/**
 * Passive pre-entry snapshot for the falling-knife adverse-move hypothesis.
 *
 * Outcome fields (actual fill price, gap, settlement, P&L) are NOT present here:
 * they can only be known after execution and reconciliation.  This record stores
 * only facts observable at trigger time — identifiers, pre-entry market conditions,
 * and gap-bucket classification buckets to guide post-hoc reconciliation joins.
 *
 * All outcome enrichment must happen through a separate reconciliation step that
 * joins this record to order_attempts / order_fills / market_results by
 * clientOrderId / snapshotId.  Do not infer fills from these fields.
 */
export interface Phase4BFallingKnifeRecord {
  id: string;
  snapshotId: string;
  hypothesisVersion: "falling-knife-adverse-move-v1";
  qualification: "eligible" | "not_eligible";
  /** Why the record is or is not eligible for outcome reconciliation. */
  reason: string;
  /** Classification buckets used for post-hoc reconciliation. */
  gapBucketExpected: "0-2c" | "3-6c" | "7-9c" | "10c+" | "unknown";
  ticker: string;
  side: Phase4BSide;
  asset: Phase4BMarketInterval["asset"];
  /** Displayed trigger price at evaluation time (cents). */
  triggerPriceCents: number | null;
  /** Configured IOC limit price (cents). */
  submittedLimitPriceCents: number | null;
  /** L2 executable best ask at pre-flight time (cents), if available. */
  l2BestAskCents: number | null;
  /** BBO-to-L2 gap at pre-flight time (cents), if available. */
  bboToL2GapCents: number | null;
  /** Correlation handle linking this record to orderAttempts. */
  clientOrderId: string | null;
  kalshiOrderId: string | null;
  /** Reference price and short-horizon returns at trigger time. */
  referencePriceAtTrigger: number | null;
  referenceReturn5s: number | null;
  referenceReturn30s: number | null;
  referenceReturn60s: number | null;
  referenceStale: boolean;
  /** BBO state at trigger time (cents). */
  entryBid: number | null;
  entryAsk: number | null;
  oppositeBid: number | null;
  oppositeAsk: number | null;
  spreadCents: number | null;
  /** Executable L2 depth at trigger time (contracts). */
  executableDepthContracts: number | null;
  /** Data-source quality indicators at trigger time. */
  source: Phase4BSource;
  wsConnected: boolean;
  wsStale: boolean;
  bboAgeMs: number | null;
  /** POST and ACK timestamps: NOT available at capture time; reserved for reconciliation. */
  postStartMs: null;
  ackMs: null;
  capturedAtMs: number;
  schemaVersion: string;
}

/**
 * Frozen prospective calculation contract. Values are descriptive evidence only:
 * threshold metadata is Kalshi contract data; referencePrice is explicitly a proxy.
 * No unavailable value is interpolated or carried forward.
 */
export interface Phase4BDistanceToBeatRecord {
  id: string;
  snapshotId: string;
  hypothesisVersion: "distance-to-beat-prospective-v1";
  qualification: "measurable" | "unavailable";
  reason: string;
  ticker: string;
  asset: Phase4BMarketInterval["asset"];
  selectedSide: Phase4BSide;
  selectedSideReason: string;
  selectedEntryPriceCents: number | null;
  secondsLeft: number;
  capturedAtMs: number;
  thresholdRule: Phase4BThresholdRuleSnapshot;
  referenceSource: string;
  referencePrice: number | null;
  referenceSourceTimestampMs: number | null;
  referenceCapturedAtMs: number;
  referenceIsProxy: true;
  signedCushionDollars: number | null;
  percentCushion: number | null;
  movement15sDollars: number | null;
  movement30sDollars: number | null;
  causal30sAnchorPrice: number | null;
  causal30sAnchorSourceTimestampMs: number | null;
  causal30sAnchorStatus: Phase4BReferenceObservation["causal30sAnchorStatus"];
  movement15sTowardOrAway: "toward" | "away" | "flat" | null;
  movement30sTowardOrAway: "toward" | "away" | "flat" | null;
  cushionOver15sMovement: number | null;
  cushionOver30sMovement: number | null;
  unavailableReasons: readonly string[];
  schemaVersion: string;
}

export const PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION = "entry-gap-90-95-v1" as const;
export const PHASE4B_ENTRY_GAP_BAND_CENTS = [90, 95] as const;

/**
 * Frozen causal entry-gap contract for high-priced (90–95¢) BTC quotes.
 * Every value is observable at capture time only: the threshold snapshot is
 * contemporaneous Kalshi contract metadata and the reference is the latest
 * causal (at-or-before) proxy point with its true source timestamp and age.
 * When a causal pair cannot be recorded, qualification is explicit and no
 * later or settlement value is ever substituted.
 */
export interface Phase4BEntryGapRecord {
  id: string;
  snapshotId: string;
  hypothesisVersion: typeof PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION;
  qualification: "in_band_measurable" | "in_band_unavailable" | "out_of_band";
  reason: string;
  ticker: string;
  asset: Phase4BMarketInterval["asset"];
  side: Phase4BSide;
  entryPriceCents: number | null;
  secondsLeft: number;
  capturedAtMs: number;
  /** Contemporaneous Kalshi threshold / price-to-beat snapshot. */
  thresholdRule: Phase4BThresholdRuleSnapshot;
  referenceSource: string;
  causalReferencePrice: number | null;
  causalReferenceSourceTimestampMs: number | null;
  causalReferenceAgeMs: number | null;
  causalEvidenceStatus: Phase4BCausalEvidenceStatus;
  /** Positive when the causal reference favors the selected side (dollars). */
  signedGapDollars: number | null;
  absoluteGapDollars: number | null;
  referenceVsTarget: "above_target" | "below_target" | "at_target" | null;
  unavailableReasons: readonly string[];
  schemaVersion: string;
}

/**
 * Union of all versioned prospective hypothesis records.
 * Both hypotheses are emitted per drain cycle; each is stored independently
 * in phase4b_prospective_simulations with its own id and hypothesisVersion.
 */
export type Phase4BAnyProspectiveRecord =
  | Phase4BProspectiveSimulationRecord
  | Phase4BFallingKnifeRecord
  | Phase4BDistanceToBeatRecord
  | Phase4BEntryGapRecord;

export function assetFor(ticker: string, series: string): Phase4BMarketInterval["asset"] {
  const value = `${ticker} ${series}`.toUpperCase();
  return value.includes("BTC") ? "BTC" : value.includes("ETH") ? "ETH" : "unknown";
}

export function marketIdFor(ticker: string): string {
  return ticker;
}

export function baselineSnapshotId(marketId: string, capturedAtMs: number): string {
  return `${marketId}:baseline:${Math.floor(capturedAtMs / 5_000) * 5_000}`;
}

export function eventSnapshotId(marketId: string, capturedAtMs: number, classification: string, attemptId?: string | null): string {
  const suffix = attemptId ? `:${attemptId}` : "";
  return `${marketId}:event:${Math.floor(capturedAtMs / 1_000) * 1_000}:${classification}${suffix}`;
}