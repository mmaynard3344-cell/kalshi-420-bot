/**
 * Local, feature-gated Phase 4B observer. Enqueue is synchronous and inert unless
 * PHASE4B_PASSIVE_CAPTURE_ENABLED is exactly "true"; it neither awaits nor alters evaluation.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Phase4BAnyProspectiveRecord, Phase4BBookSnapshot, Phase4BCaptureInput, Phase4BDecisionSnapshot, Phase4BDistanceToBeatRecord, Phase4BEntryGapRecord, Phase4BMarketInterval, Phase4BProspectiveSimulationRecord, Phase4BReferenceObservation, Phase4BThresholdRuleSnapshot } from "./types.js";
import { assetFor, baselineSnapshotId, eventSnapshotId, marketIdFor, PHASE4B_ENTRY_GAP_BAND_CENTS, PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION, PHASE4B_MAX_QUEUE, PHASE4B_SCHEMA_VERSION } from "./types.js";
import { buildPhase4BReferenceObservation } from "./referenceFeatures.js";
import { buildPassiveExperimentCaptures, PROGRAM_E_EXTERNAL_SOURCES } from "./passiveExperimentRegistry.js";
import type { ProgramEExternalObservation, ProgramEExternalSource } from "./passiveExperimentRegistry.js";
import { appendReferencePoint, getReferenceHistory, getPhase4BReferenceHistoryCorruptReloadCount, _resetPhase4BReferenceHistoryForTesting } from "./referenceHistoryStore.js";
import type { KalshiOrderbookRaw } from "../orderbookParsing.js";

type Writer = (market: Phase4BMarketInterval, snapshot: Phase4BDecisionSnapshot, books: readonly Phase4BBookSnapshot[], reference: Phase4BReferenceObservation, prospective: readonly Phase4BAnyProspectiveRecord[], registry: readonly Record<string, unknown>[]) => Promise<void>;
type ReferenceEnricher = (
  market: Phase4BMarketInterval,
  snapshot: Phase4BDecisionSnapshot,
) => Promise<Phase4BReferenceObservation>;
type ProgramEExternalEvidenceEnricher = (
  market: Phase4BMarketInterval,
  snapshot: Phase4BDecisionSnapshot,
) => Promise<Partial<Record<ProgramEExternalSource, ProgramEExternalObservation>>>;
type Capture = { market: Phase4BMarketInterval; snapshot: Phase4BDecisionSnapshot };
type SpoolRecord = {
  captureId: string;
  captureTimestampMs: number;
  ticker: string;
  payload: Capture;
  retryCount: number;
  lastError: string;
  spooledAtMs: number;
};
const queue: Array<{ market: Phase4BMarketInterval; snapshot: Phase4BDecisionSnapshot }> = [];
const seen = new Set<string>();
let draining = false;
let replaying = false;
let spoolPath = process.env["PHASE4B_CAPTURE_SPOOL_PATH"] ?? join(process.cwd(), "data", "phase4b", "capture-failures.ndjson");
let testResetSpoolDirectory: string | null = null;
const ENRICH_TIMEOUT_MS = 2_000;
const REFERENCE_STALE_MS = 15_000;
const WRITE_MAX_ATTEMPTS = 5;
const WRITE_RETRY_BASE_MS = 25;
const lastBookCaptureMs = new Map<string, number>();
const externalObservationsBySource = new Map<ProgramEExternalSource, ProgramEExternalObservation>();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("phase4b_enrichment_timeout")), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function enrichReferenceFromKraken(
  market: Phase4BMarketInterval,
  snapshot: Phase4BDecisionSnapshot,
): Promise<Phase4BReferenceObservation> {
  try {
    const { getKrakenPrices } = await import("../krakenPrices.js");
    const prices = await withTimeout(getKrakenPrices(snapshot.capturedAtMs), ENRICH_TIMEOUT_MS);
    const price = market.asset === "BTC" ? prices.btc : market.asset === "ETH" ? prices.eth : null;
    // The point is persisted (restart-proof) even when the fetch is stale: a
    // stale-but-causal observation is still legitimate prior evidence.
    const history = price != null
      ? appendReferencePoint(market.asset, { timestampMs: prices.sourceTimestampMs, price }, snapshot.capturedAtMs)
      : getReferenceHistory(market.asset, snapshot.capturedAtMs);
    const cacheAgeMs = prices.cacheAgeMs;
    const stale = cacheAgeMs > REFERENCE_STALE_MS;
    return buildPhase4BReferenceObservation({
      snapshotId: snapshot.snapshotId, asset: market.asset, source: "kraken",
      referencePrice: stale ? null : price, sourceTimestampMs: prices.sourceTimestampMs,
      capturedAtMs: snapshot.capturedAtMs, error: stale ? "stale_reference_price" : null,
      history, intervalStartMs: market.intervalStartMs, cacheAgeMs, stale,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reference_fetch_error";
    return buildPhase4BReferenceObservation({
      snapshotId: snapshot.snapshotId, asset: market.asset, source: "kraken",
      referencePrice: null, sourceTimestampMs: null, capturedAtMs: snapshot.capturedAtMs,
      error: message === "phase4b_enrichment_timeout" ? "reference_timeout" : "reference_fetch_error",
      history: getReferenceHistory(market.asset, snapshot.capturedAtMs), intervalStartMs: market.intervalStartMs,
    });
  }
}

let referenceEnricher: ReferenceEnricher = enrichReferenceFromKraken;
const retainedProgramEExternalEvidence: ProgramEExternalEvidenceEnricher = async (_market, snapshot) =>
  Object.fromEntries(PROGRAM_E_EXTERNAL_SOURCES.flatMap((source) => {
    const observation = externalObservationsBySource.get(source);
    return observation != null && observation.capturedAtMs != null && observation.capturedAtMs <= snapshot.capturedAtMs
      ? [[source, { ...observation }]] : [];
  })) as Partial<Record<ProgramEExternalSource, ProgramEExternalObservation>>;
let programEExternalEvidenceEnricher: ProgramEExternalEvidenceEnricher = retainedProgramEExternalEvidence;

async function enrich(
  market: Phase4BMarketInterval,
  snapshot: Phase4BDecisionSnapshot,
): Promise<{ books: readonly Phase4BBookSnapshot[]; reference: Phase4BReferenceObservation; externalObservations: Partial<Record<ProgramEExternalSource, ProgramEExternalObservation>> }> {
  const [reference, externalObservations] = await Promise.all([
    referenceEnricher(market, snapshot), programEExternalEvidenceEnricher(market, snapshot),
  ]);
  const cadenceMs = snapshot.displayedEntryPriceCents != null ? 5_000 : 15_000;
  const last = lastBookCaptureMs.get(market.marketId) ?? 0;
  if (snapshot.capturedAtMs - last < cadenceMs) return { books: [], reference, externalObservations };
  lastBookCaptureMs.set(market.marketId, snapshot.capturedAtMs);
  try {
    const [{ kalshiFetch }, { normalizePhase4BBook }] = await Promise.all([
      import("../kalshi.js"), import("./orderbookSnapshot.js"),
    ]);
    const started = Date.now();
    const raw = await withTimeout(kalshiFetch<KalshiOrderbookRaw>(`/markets/${market.ticker}/orderbook`), ENRICH_TIMEOUT_MS);
    const latency = Date.now() - started;
    return {
      books: [
        normalizePhase4BBook(raw, "yes", snapshot.snapshotId, snapshot.configuredLimitCents, started, latency),
        normalizePhase4BBook(raw, "no", snapshot.snapshotId, snapshot.configuredLimitCents, started, latency),
      ],
      reference, externalObservations,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "phase4b_book_error";
    const { normalizePhase4BBook } = await import("./orderbookSnapshot.js");
    const empty = {} as Parameters<typeof normalizePhase4BBook>[0];
    return {
      books: [
        normalizePhase4BBook(empty, "yes", snapshot.snapshotId, snapshot.configuredLimitCents, Date.now(), 0, message),
        normalizePhase4BBook(empty, "no", snapshot.snapshotId, snapshot.configuredLimitCents, Date.now(), 0, message),
      ],
      reference, externalObservations,
    };
  }
}

function prospectiveRecords(
  market: Phase4BMarketInterval,
  snapshot: Phase4BDecisionSnapshot,
  reference: Phase4BReferenceObservation,
): readonly Phase4BAnyProspectiveRecord[] {
  const price = snapshot.displayedEntryPriceCents;
  const qualified = snapshot.candidateSide === "no" && price != null && price >= 70 && price <= 76
    && reference.stale === false && reference.return30s != null && reference.return30s > 0;
  const reason = qualified ? "no_70_76_positive_valid_return30s" :
    snapshot.candidateSide !== "no" ? "side_not_no" :
    price == null || price < 70 || price > 76 ? "price_outside_70_76" :
    reference.stale ? "reference_stale" :
    reference.return30s == null ? "return30s_unavailable" : "return30s_not_positive";
  const no7076: Phase4BProspectiveSimulationRecord = {
    id: `${snapshot.snapshotId}:no-70-76-positive-valid-return30s-v1`,
    snapshotId: snapshot.snapshotId, hypothesisVersion: "no-70-76-positive-valid-return30s-v1",
    qualification: qualified ? "qualified" : "not_qualified", reason, ticker: market.ticker,
    side: snapshot.candidateSide, candidateEntryPriceCents: price, referenceReturn30s: reference.return30s,
    referenceStale: reference.stale, capturedAtMs: snapshot.capturedAtMs, schemaVersion: PHASE4B_SCHEMA_VERSION,
  };
  const entryBid = snapshot.candidateSide === "yes" ? snapshot.yesBid : snapshot.noBid;
  const entryAsk = snapshot.candidateSide === "yes" ? snapshot.yesAsk : snapshot.noAsk;
  const oppositeBid = snapshot.candidateSide === "yes" ? snapshot.noBid : snapshot.yesBid;
  const oppositeAsk = snapshot.candidateSide === "yes" ? snapshot.noAsk : snapshot.yesAsk;
  const fallingKnife = {
    id: `${snapshot.snapshotId}:falling-knife-adverse-move-v1`,
    snapshotId: snapshot.snapshotId, hypothesisVersion: "falling-knife-adverse-move-v1" as const,
    qualification: snapshot.clientOrderId ? "eligible" as const : "not_eligible" as const,
    reason: snapshot.clientOrderId ? "attempt_id_present_for_reconciliation" : "attempt_id_unavailable",
    gapBucketExpected: "unknown" as const, ticker: market.ticker, side: snapshot.candidateSide, asset: market.asset,
    triggerPriceCents: snapshot.displayedEntryPriceCents, submittedLimitPriceCents: snapshot.configuredLimitCents,
    l2BestAskCents: snapshot.executableL2AskCents, bboToL2GapCents: snapshot.bboToL2GapCents,
    clientOrderId: snapshot.clientOrderId, kalshiOrderId: snapshot.kalshiOrderId,
    referencePriceAtTrigger: reference.referencePrice, referenceReturn5s: reference.return5s,
    referenceReturn30s: reference.return30s, referenceReturn60s: reference.return60s, referenceStale: reference.stale,
    entryBid, entryAsk, oppositeBid, oppositeAsk,
    spreadCents: entryBid != null && entryAsk != null ? entryAsk - entryBid : null,
    executableDepthContracts: snapshot.executableL2DepthContracts, source: snapshot.source,
    wsConnected: snapshot.wsConnected, wsStale: snapshot.wsStale, bboAgeMs: snapshot.bboAgeMs,
    postStartMs: null, ackMs: null, capturedAtMs: snapshot.capturedAtMs, schemaVersion: PHASE4B_SCHEMA_VERSION,
  };
  const threshold: Phase4BThresholdRuleSnapshot = snapshot.thresholdRule ?? {
    captureVersion: "distance-to-beat-prospective-v1", source: "unavailable", observedAtMs: snapshot.capturedAtMs,
    floorStrike: null, comparisonOperator: null, rulesPrimary: null, rulesSecondary: null, rulesHash: null,
    unavailableReason: "market_rule_metadata_not_available_at_capture",
  };
  const unavailableReasons: string[] = [];
  if (threshold.floorStrike == null || threshold.comparisonOperator == null || threshold.source === "unavailable") {
    unavailableReasons.push(threshold.unavailableReason ?? "authoritative_threshold_or_rule_unavailable");
  }
  if (reference.referencePrice == null || reference.stale || reference.error || reference.sourceTimestampMs == null || reference.sourceTimestampMs > snapshot.capturedAtMs) {
    unavailableReasons.push("timestamp_safe_proxy_reference_unavailable");
  }
  const signedCushionDollars = unavailableReasons.length ? null
    : snapshot.candidateSide === "yes"
      ? reference.referencePrice! - threshold.floorStrike!
      : threshold.floorStrike! - reference.referencePrice!;
  const movementDollars = (fraction: number | null) =>
    fraction == null || reference.referencePrice == null ? null : reference.referencePrice - (reference.referencePrice / (1 + fraction));
  const classifyMovement = (movement: number | null) => {
    if (movement == null) return null;
    const cushionChange = snapshot.candidateSide === "yes" ? movement : -movement;
    return cushionChange > 0 ? "away" as const : cushionChange < 0 ? "toward" as const : "flat" as const;
  };
  const move15 = movementDollars(reference.return15s);
  const move30 = movementDollars(reference.return30s);
  const distance: Phase4BDistanceToBeatRecord = {
    id: `${snapshot.snapshotId}:distance-to-beat-prospective-v1`, snapshotId: snapshot.snapshotId,
    hypothesisVersion: "distance-to-beat-prospective-v1", qualification: unavailableReasons.length ? "unavailable" : "measurable",
    reason: unavailableReasons[0] ?? "all_required_inputs_timestamp_safe", ticker: market.ticker, asset: market.asset,
    selectedSide: snapshot.candidateSide, selectedSideReason: snapshot.selectedSideReason,
    selectedEntryPriceCents: snapshot.displayedEntryPriceCents,
    secondsLeft: snapshot.secondsLeft, capturedAtMs: snapshot.capturedAtMs, thresholdRule: threshold,
    referenceSource: reference.source, referencePrice: reference.referencePrice, referenceSourceTimestampMs: reference.sourceTimestampMs,
    referenceCapturedAtMs: reference.capturedAtMs, referenceIsProxy: true,
    signedCushionDollars: signedCushionDollars == null ? null : Number(signedCushionDollars.toFixed(6)),
    percentCushion: signedCushionDollars == null || threshold.floorStrike === null || threshold.floorStrike === 0
      ? null : Number((signedCushionDollars / threshold.floorStrike * 100).toFixed(8)),
    movement15sDollars: move15 == null ? null : Number(move15.toFixed(6)),
    movement30sDollars: move30 == null ? null : Number(move30.toFixed(6)),
    causal30sAnchorPrice: reference.causal30sAnchorPrice,
    causal30sAnchorSourceTimestampMs: reference.causal30sAnchorSourceTimestampMs,
    causal30sAnchorStatus: reference.causal30sAnchorStatus,
    movement15sTowardOrAway: classifyMovement(move15), movement30sTowardOrAway: classifyMovement(move30),
    cushionOver15sMovement: signedCushionDollars == null || move15 == null || move15 === 0 ? null : Number((signedCushionDollars / Math.abs(move15)).toFixed(6)),
    cushionOver30sMovement: signedCushionDollars == null || move30 == null || move30 === 0 ? null : Number((signedCushionDollars / Math.abs(move30)).toFixed(6)),
    unavailableReasons, schemaVersion: PHASE4B_SCHEMA_VERSION,
  };
  const entryGapUnavailable: string[] = [];
  if (threshold.floorStrike == null || threshold.comparisonOperator == null || threshold.source === "unavailable") {
    entryGapUnavailable.push(threshold.unavailableReason ?? "authoritative_threshold_or_rule_unavailable");
  }
  if (reference.causalReferencePrice == null || reference.causalReferenceSourceTimestampMs == null || reference.causalEvidenceStatus === "unavailable") {
    entryGapUnavailable.push("causal_reference_unavailable_at_or_before_capture");
  }
  const [bandFloor, bandCeiling] = PHASE4B_ENTRY_GAP_BAND_CENTS;
  const inBand = market.asset === "BTC" && price != null && price >= bandFloor && price <= bandCeiling;
  const signedGapDollars = entryGapUnavailable.length ? null
    : snapshot.candidateSide === "yes"
      ? reference.causalReferencePrice! - threshold.floorStrike!
      : threshold.floorStrike! - reference.causalReferencePrice!;
  const entryGap: Phase4BEntryGapRecord = {
    id: `${snapshot.snapshotId}:${PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION}`, snapshotId: snapshot.snapshotId,
    hypothesisVersion: PHASE4B_ENTRY_GAP_HYPOTHESIS_VERSION,
    qualification: !inBand ? "out_of_band" : entryGapUnavailable.length ? "in_band_unavailable" : "in_band_measurable",
    reason: !inBand ? "entry_price_outside_btc_90_95_band" : entryGapUnavailable[0] ?? "causal_reference_and_threshold_available",
    ticker: market.ticker, asset: market.asset, side: snapshot.candidateSide, entryPriceCents: price,
    secondsLeft: snapshot.secondsLeft, capturedAtMs: snapshot.capturedAtMs, thresholdRule: threshold,
    referenceSource: reference.source,
    causalReferencePrice: reference.causalReferencePrice,
    causalReferenceSourceTimestampMs: reference.causalReferenceSourceTimestampMs,
    causalReferenceAgeMs: reference.causalReferenceAgeMs,
    causalEvidenceStatus: reference.causalEvidenceStatus,
    signedGapDollars: signedGapDollars == null ? null : Number(signedGapDollars.toFixed(6)),
    absoluteGapDollars: signedGapDollars == null ? null : Number(Math.abs(signedGapDollars).toFixed(6)),
    referenceVsTarget: entryGapUnavailable.length ? null
      : reference.causalReferencePrice! > threshold.floorStrike! ? "above_target"
        : reference.causalReferencePrice! < threshold.floorStrike! ? "below_target" : "at_target",
    unavailableReasons: entryGapUnavailable, schemaVersion: PHASE4B_SCHEMA_VERSION,
  };
  return [no7076, fallingKnife, distance, entryGap];
}

let writer: Writer = async (market, snapshot, books, reference, prospective, registry) => {
  const store = await import("../tradeStore.js");
  await store.insertPhase4BDecisionCaptureInSql({
    market: market as unknown as Record<string, unknown>,
    snapshot: snapshot as unknown as Record<string, unknown>,
    books: books as unknown as readonly Record<string, unknown>[],
    reference: reference as unknown as Record<string, unknown>,
    prospective: prospective as unknown as readonly Record<string, unknown>[],
    registry,
  });
};

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isTransientDatabaseError(error: unknown): boolean {
  const message = errorSummary(error).toLowerCase();
  return /\b(0800[0-7]|57p01|53300)\b|timeout|timed out|connection|connect|socket|econnreset|econnrefused|network/i.test(message);
}

function retryDelayMs(attempt: number): number {
  // Bounded exponential backoff. No random jitter here: capture ordering and
  // focused tests remain deterministic; the small per-record queue already
  // serializes retries and avoids a connection storm.
  return WRITE_RETRY_BASE_MS * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const metrics = {
  accepted: 0,
  deduped: 0,
  dropped: 0,
  failed: 0,
  written: 0,
  highWater: 0,
  enqueueAttempts: 0,
  mostRecentEnqueueAtMs: null as number | null,
  mostRecentSuccessfulWriteAtMs: null as number | null,
  mostRecentWriteError: null as string | null,
  retryAttempts: 0,
  replayed: 0,
  replayFailed: 0,
};

export function isPhase4BPassiveCaptureEnabled(): boolean {
  return process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] === "true";
}

function makeRecords(input: Readonly<Phase4BCaptureInput>, eventClass: string | null) {
  const marketId = marketIdFor(input.ticker);
  const capturedAtMs = input.timestampMs;
  const snapshotId = eventClass ? eventSnapshotId(marketId, capturedAtMs, eventClass, input.clientOrderId) : baselineSnapshotId(marketId, capturedAtMs);
  const closeMs = new Date(input.closeTime).getTime();
  const openMs = input.openTime ? new Date(input.openTime).getTime() : null;
  const yesDerivedAsk = input.noBid == null ? null : 100 - input.noBid;
  const noDerivedAsk = input.yesBid == null ? null : 100 - input.yesBid;
  const thresholdRule: Phase4BThresholdRuleSnapshot = input.thresholdRule ?? {
    captureVersion: "distance-to-beat-prospective-v1", source: "unavailable", observedAtMs: capturedAtMs,
    floorStrike: null, comparisonOperator: null, rulesPrimary: null, rulesSecondary: null, rulesHash: null,
    unavailableReason: "market_rule_metadata_not_available_at_capture",
  };
  const market: Phase4BMarketInterval = { marketId, ticker: input.ticker, series: input.series, asset: assetFor(input.ticker, input.series), intervalStartMs: Number.isFinite(openMs) ? openMs : null, intervalEndMs: Number.isFinite(closeMs) ? closeMs : null, windowCloseMs: Number.isFinite(closeMs) ? closeMs : capturedAtMs, metadataCapturedAtMs: capturedAtMs, schemaVersion: PHASE4B_SCHEMA_VERSION, metadataVersion: "market-state-v2-distance-to-beat" };
  const snapshot: Phase4BDecisionSnapshot = {
    snapshotId, marketId, capturedAtMs, secondsLeft: input.secondsLeft, candidateSide: input.side,
    selectedSideReason: input.selectedSideReason ?? "selection_reason_not_retained_by_legacy_capture", source: input.source,
    wsConnected: input.wsConnected, wsStale: input.wsStale, lastWsMessageAgeMs: input.lastWsMessageAgeMs, bboAgeMs: input.bboAgeMs,
    restFallbackActive: input.source === "rest_fallback", restFallbackReason: input.source === "rest_fallback" ? "market_data_fallback" : null,
    yesBid: input.yesBid, yesAsk: input.yesAsk, noBid: input.noBid, noAsk: input.noAsk, yesDerivedAsk, noDerivedAsk,
    yesSpreadCents: input.yesBid != null && input.yesAsk != null ? input.yesAsk - input.yesBid : null,
    noSpreadCents: input.noBid != null && input.noAsk != null ? input.noAsk - input.noBid : null,
    displayedEntryPriceCents: input.displayedEntryPriceCents, configuredLimitCents: input.configuredLimitCents, bboDerivedLimitCents: input.bboDerivedLimitCents,
    strategyVersion: input.strategyVersion, betDollars: input.betDollars, priceFloorCents: input.priceFloorCents, priceCapCents: input.priceCapCents,
    limitBufferCents: input.limitBufferCents, staleGapThresholdCents: input.staleGapThresholdCents, decisionClassification: input.decisionClassification,
    skipReason: input.skipReason, quotedBboAskCents: input.quotedBboAskCents, executableL2AskCents: input.executableL2AskCents,
    bboToL2GapCents: input.bboToL2GapCents, preflightLatencyMs: input.preflightLatencyMs,
    finalDecisionClassification: input.finalDecisionClassification ?? null,
    finalOrderPathOutcome: input.finalOrderPathOutcome ?? null,
    guardOutcomes: input.guardOutcomes ?? null,
    allOtherGuardsPassed: input.allOtherGuardsPassed ?? null,
    executableL2DepthContracts: input.executableL2DepthContracts ?? null,
    intendedContractCount: input.intendedContractCount ?? null,
    intendedNotionalCents: input.intendedNotionalCents ?? null,
    availableExposureDollars: input.availableExposureDollars ?? null,
    estimatedFeesDollars: input.estimatedFeesDollars ?? null,
    clientOrderId: input.clientOrderId ?? null,
    kalshiOrderId: input.kalshiOrderId ?? null,
    thresholdRule,
    schemaVersion: PHASE4B_SCHEMA_VERSION,
  };
  return { market, snapshot };
}

function readSpool(): { valid: SpoolRecord[]; malformed: string[] } {
  if (!existsSync(spoolPath)) return { valid: [], malformed: [] };
  const valid: SpoolRecord[] = [];
  const malformed: string[] = [];
  for (const line of readFileSync(spoolPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<SpoolRecord>;
      if (!value.captureId || !value.payload?.market || !value.payload.snapshot) throw new Error("invalid_spool_record");
      valid.push(value as SpoolRecord);
    } catch (error) {
      console.warn("phase4b: malformed spool record retained", { spoolPath, error: errorSummary(error) });
      malformed.push(line);
    }
  }
  return { valid, malformed };
}

function hasSpoolRecords(): boolean {
  return existsSync(spoolPath) && readFileSync(spoolPath, "utf8").trim().length > 0;
}

function writeSpool(records: readonly SpoolRecord[], malformed: readonly string[] = []): void {
  mkdirSync(dirname(spoolPath), { recursive: true });
  const content = [...malformed, ...records.map((record) => JSON.stringify(record))].join("\n");
  const temporary = `${spoolPath}.tmp`;
  writeFileSync(temporary, content ? `${content}\n` : "", "utf8");
  renameSync(temporary, spoolPath);
}

function spoolFailedCapture(capture: Capture, retryCount: number, error: unknown): void {
  const record: SpoolRecord = {
    captureId: capture.snapshot.snapshotId,
    captureTimestampMs: capture.snapshot.capturedAtMs,
    ticker: capture.market.ticker,
    payload: capture,
    retryCount,
    lastError: errorSummary(error),
    spooledAtMs: Date.now(),
  };
  try {
    mkdirSync(dirname(spoolPath), { recursive: true });
    appendFileSync(spoolPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (spoolError) {
    console.warn("phase4b: failed to spool capture", {
      captureId: record.captureId, ticker: record.ticker, error: errorSummary(spoolError),
    });
  }
}

async function writeCapture(capture: Capture): Promise<{ success: true } | { success: false; error: unknown; attempts: number }> {
  const { books, reference, externalObservations } = await enrich(capture.market, capture.snapshot);
  const prospective = prospectiveRecords(capture.market, capture.snapshot, reference);
  const registry = buildPassiveExperimentCaptures(capture.market, capture.snapshot, reference, externalObservations);
  let lastError: unknown = new Error("phase4b_write_not_attempted");
  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      await writer(capture.market, capture.snapshot, books, reference, prospective, registry as readonly Record<string, unknown>[]);
      return { success: true };
    } catch (error) {
      lastError = error;
      const summary = errorSummary(error);
      const transient = isTransientDatabaseError(error);
      metrics.failed++;
      metrics.mostRecentWriteError = summary;
      console.warn("phase4b: capture write failed", {
        error: summary, captureId: capture.snapshot.snapshotId, ticker: capture.market.ticker,
        captureTimestampMs: capture.snapshot.capturedAtMs, queueDepth: queue.length,
        attempt, maxAttempts: WRITE_MAX_ATTEMPTS, transient,
      });
      if (!transient || attempt === WRITE_MAX_ATTEMPTS) return { success: false, error, attempts: attempt };
      metrics.retryAttempts++;
      await sleep(retryDelayMs(attempt));
    }
  }
  return { success: false, error: lastError, attempts: WRITE_MAX_ATTEMPTS };
}

export async function replayPhase4BSpool(): Promise<void> {
  if (replaying) return;
  replaying = true;
  try {
    const { valid, malformed } = readSpool();
    const remaining: SpoolRecord[] = [];
    for (const record of valid) {
      const result = await writeCapture(record.payload);
      if (result.success) {
        metrics.written++;
        metrics.replayed++;
        metrics.mostRecentSuccessfulWriteAtMs = Date.now();
      } else {
        metrics.replayFailed++;
        remaining.push(record);
      }
    }
    writeSpool(remaining, malformed);
  } finally {
    replaying = false;
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const next = queue.shift();
      if (!next) continue;
      try {
        const result = await writeCapture(next);
        if (!result.success) {
          spoolFailedCapture(next, result.attempts, result.error);
          continue;
        }
        metrics.written++;
        metrics.mostRecentSuccessfulWriteAtMs = Date.now();
        if (hasSpoolRecords()) void replayPhase4BSpool();
      } catch (error) {
        metrics.failed++;
        metrics.mostRecentWriteError = errorSummary(error);
        console.warn("phase4b: capture preparation failed", {
          error: metrics.mostRecentWriteError,
          captureId: next.snapshot.snapshotId,
          ticker: next.market.ticker,
          captureTimestampMs: next.snapshot.capturedAtMs,
          queueDepth: queue.length,
          attempt: 1,
        });
      }
    }
  } finally { draining = false; }
}

export function enqueuePhase4BPassiveCapture(input: Readonly<Phase4BCaptureInput>, eventClassification: string | null = null): void {
  if (!isPhase4BPassiveCaptureEnabled() || input.secondsLeft < 1 || input.secondsLeft > 180) return;
  metrics.enqueueAttempts++;
  try {
    const { market, snapshot } = makeRecords({ ...input }, eventClassification);
    if (seen.has(snapshot.snapshotId)) { metrics.deduped++; return; }
    if (queue.length >= PHASE4B_MAX_QUEUE) { metrics.dropped++; return; }
    seen.add(snapshot.snapshotId); queue.push({ market: { ...market }, snapshot: { ...snapshot } });
    metrics.accepted++;
    metrics.mostRecentEnqueueAtMs = Date.now();
    metrics.highWater = Math.max(metrics.highWater, queue.length);
    void drain();
  } catch {
    metrics.failed++;
    metrics.mostRecentWriteError = "write_failed";
  }
}

export function getPhase4BPassiveCaptureStatus() {
  return {
    enabled: isPhase4BPassiveCaptureEnabled(),
    referenceHistoryCorruptReloads: getPhase4BReferenceHistoryCorruptReloadCount(),
    queueDepth: queue.length,
    draining,
    accepted: metrics.accepted,
    deduped: metrics.deduped,
    dropped: metrics.dropped,
    failed: metrics.failed,
    written: metrics.written,
    highWater: metrics.highWater,
    enqueueAttempts: metrics.enqueueAttempts,
    successfulWrites: metrics.written,
    failedWrites: metrics.failed,
    queueDrops: metrics.dropped,
    mostRecentEnqueueAt: metrics.mostRecentEnqueueAtMs == null ? null : new Date(metrics.mostRecentEnqueueAtMs).toISOString(),
    mostRecentSuccessfulWriteAt: metrics.mostRecentSuccessfulWriteAtMs == null ? null : new Date(metrics.mostRecentSuccessfulWriteAtMs).toISOString(),
    mostRecentWriteError: metrics.mostRecentWriteError,
    retryAttempts: metrics.retryAttempts,
    spoolRecordCount: readSpool().valid.length,
    replayed: metrics.replayed,
    replayFailed: metrics.replayFailed,
  };
}
export function _setPhase4BWriterForTesting(next: Writer): void { writer = next; }
export function _setPhase4BSpoolPathForTesting(path: string): void {
  if (testResetSpoolDirectory) {
    rmSync(testResetSpoolDirectory, { recursive: true, force: true });
    testResetSpoolDirectory = null;
  }
  spoolPath = path;
}
export function _initializePhase4BSpoolReplayForTesting(): void { void replayPhase4BSpool(); }
/** Test-only seam: keeps queue/writer tests fully offline and deterministic. */
export function _setPhase4BReferenceEnricherForTesting(next: ReferenceEnricher): void { referenceEnricher = next; }
/** Passive-only ingestion seam for timestamped external research observations. */
export function recordPhase4BProgramEExternalObservation(observation: ProgramEExternalObservation): void {
  if (!PROGRAM_E_EXTERNAL_SOURCES.includes(observation.source)) return;
  const prior = externalObservationsBySource.get(observation.source);
  if (prior?.capturedAtMs != null && observation.capturedAtMs != null && prior.capturedAtMs > observation.capturedAtMs) return;
  externalObservationsBySource.set(observation.source, { ...observation });
}
/** Test-only seam: production reads the immutable observation buffer above. */
export function _setPhase4BProgramEExternalEvidenceEnricherForTesting(next: ProgramEExternalEvidenceEnricher): void {
  programEExternalEvidenceEnricher = next;
}
export function _resetPhase4BForTesting(): void {
  if (testResetSpoolDirectory) rmSync(testResetSpoolDirectory, { recursive: true, force: true });
  testResetSpoolDirectory = mkdtempSync(join(tmpdir(), "phase4b-reset-spool-"));
  spoolPath = join(testResetSpoolDirectory, "captures.ndjson");
  queue.length = 0; seen.clear(); draining = false; replaying = false;
  lastBookCaptureMs.clear(); externalObservationsBySource.clear(); _resetPhase4BReferenceHistoryForTesting();
  referenceEnricher = enrichReferenceFromKraken; programEExternalEvidenceEnricher = retainedProgramEExternalEvidence;
  writer = async (market, snapshot, books, reference, prospective, registry) => {
    const store = await import("../tradeStore.js");
    await store.insertPhase4BDecisionCaptureInSql({
      market: market as unknown as Record<string, unknown>,
      snapshot: snapshot as unknown as Record<string, unknown>,
      books: books as unknown as readonly Record<string, unknown>[],
      reference: reference as unknown as Record<string, unknown>,
      prospective: prospective as unknown as readonly Record<string, unknown>[],
      registry,
    });
  };
  metrics.accepted = 0;
  metrics.deduped = 0;
  metrics.dropped = 0;
  metrics.failed = 0;
  metrics.written = 0;
  metrics.highWater = 0;
  metrics.enqueueAttempts = 0;
  metrics.mostRecentEnqueueAtMs = null;
  metrics.mostRecentSuccessfulWriteAtMs = null;
  metrics.mostRecentWriteError = null;
  metrics.retryAttempts = 0;
  metrics.replayed = 0;
  metrics.replayFailed = 0;
}

// Startup recovery remains local to this passive module. It is intentionally
// asynchronous and never blocks evaluation or changes live trading behavior.
void replayPhase4BSpool();