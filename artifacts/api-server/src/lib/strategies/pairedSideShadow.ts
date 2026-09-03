/**
 * Passive paired-side telemetry. This module is intentionally detached from
 * paired reservation and order submission: it receives already-observed books
 * and only appends research evidence.
 */
import type { Eth30PositionEventParams, Eth30ShadowObservationParams } from "../tradeStore.js";

export const PAIRED_SIDE_STUDY_VERSION = "paired-side-20-30-70-80-lead-lag-v1";
const LABEL = "SHADOW_ONLY_NOT_EXECUTED";
const LOW = [20, 30] as const, HIGH = [70, 80] as const;

export type PairedSideStore = {
  listEth30ShadowObservations(ticker: string, afterMs?: number): Promise<Eth30ShadowObservationParams[]>;
  insertEth30ShadowObservation(params: Eth30ShadowObservationParams): Promise<boolean>;
};
export type PairedSideSettlementStore = PairedSideStore & {
  listEth30PositionEvents(ticker: string): Promise<Eth30PositionEventParams[]>;
};
export type PairedSideInput = {
  ticker: string; observedAtMs: number; sourceTimestampMs: number | null;
  yes: { priceCents: number | null; depthContracts: number | null };
  no: { priceCents: number | null; depthContracts: number | null };
};
const inBand = (value: number | null, [min, max]: readonly number[]) => value != null && value >= min && value <= max;
const parse = (value: string): Record<string, unknown> | null => { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } };

/** Pure capture builder; movement is only compared to a strictly earlier record. */
export function buildPairedSidePayload(input: PairedSideInput, previous: Record<string, unknown> | null) {
  const yesLow = inBand(input.yes.priceCents, LOW), noLow = inBand(input.no.priceCents, LOW);
  const yesHigh = inBand(input.yes.priceCents, HIGH), noHigh = inBand(input.no.priceCents, HIGH);
  const low = yesLow ? { side: "yes", ...input.yes } : noLow ? { side: "no", ...input.no } : null;
  const high = yesHigh ? { side: "yes", ...input.yes } : noHigh ? { side: "no", ...input.no } : null;
  const candidate = low != null && high != null && low.side !== high.side
    && (low.depthContracts ?? 0) > 0 && (high.depthContracts ?? 0) > 0;
  const previousLow = previous?.["lowLeg"] as Record<string, unknown> | undefined;
  const previousHigh = previous?.["highLeg"] as Record<string, unknown> | undefined;
  const lowMoved = previous != null && (previousLow?.["priceCents"] !== low?.priceCents || previousLow?.["depthContracts"] !== low?.depthContracts);
  const highMoved = previous != null && (previousHigh?.["priceCents"] !== high?.priceCents || previousHigh?.["depthContracts"] !== high?.depthContracts);
  const priorAt = typeof previous?.["observedAtMs"] === "number" ? previous.observedAtMs : null;
  return {
    label: LABEL, studyVersion: PAIRED_SIDE_STUDY_VERSION, observationKind: "paired_side_quote",
    ticker: input.ticker, observedAtMs: input.observedAtMs, sourceTimestampMs: input.sourceTimestampMs,
    receiptTimestampMs: Date.now(), lowLeg: low, highLeg: high,
    candidateStatus: candidate ? "candidate_with_executable_depth" : "not_candidate_or_depth_unavailable",
    sourceFidelity: input.sourceTimestampMs == null ? "receipt_timestamp_only" : "source_and_receipt_timestamp_retained",
    priorObservationAtMs: priorAt, lowSideChangedSincePrior: lowMoved, highSideChangedSincePrior: highMoved,
    firstObservedReprice: lowMoved && !highMoved ? "cheap_side" : highMoved && !lowMoved ? "expensive_side" : lowMoved || highMoved ? "simultaneous_or_ambiguous" : "no_change",
    leadLagDurationMs: priorAt == null || !(lowMoved || highMoved) ? null : input.observedAtMs - priorAt,
    cheapSideLiquidityDisappearedAfterExpensiveMove: highMoved && !lowMoved && (low?.depthContracts ?? 0) <= 0,
    executionLabel: "unlabeled_until_durable_decision_evidence",
    settlementLabel: null,
  };
}

export async function observePairedSideShadow(store: PairedSideStore, input: PairedSideInput): Promise<void> {
  if (!/^KXETH15M-/.test(input.ticker)) return;
  const prior = await store.listEth30ShadowObservations(input.ticker, input.observedAtMs - 60_000);
  const priorPayload = [...prior].reverse().map((row) => parse(row.payloadJson))
    .find((row) => row?.["studyVersion"] === PAIRED_SIDE_STUDY_VERSION && Number(row["observedAtMs"]) < input.observedAtMs) ?? null;
  const payload = buildPairedSidePayload(input, priorPayload);
  await store.insertEth30ShadowObservation({
    id: `${input.ticker}:paired-side:${input.observedAtMs}`, ticker: input.ticker, observedAtMs: input.observedAtMs,
    payloadJson: JSON.stringify(payload),
  });
}

/**
 * Appends eventual outcome evidence to each immutable paired-side quote after
 * the strategy's settlement ledger has recorded the exchange result. This is
 * intentionally a ledger-to-research projection: it does not inspect books,
 * orders, fills, reservations, or any execution state.
 */
export async function refreshPairedSideSettlementOutcomes(
  store: PairedSideSettlementStore,
  ticker: string,
): Promise<void> {
  const [observations, events] = await Promise.all([
    store.listEth30ShadowObservations(ticker),
    store.listEth30PositionEvents(ticker),
  ]);
  const settlement = events.find((event) =>
    event.eventType === "settlement" && (event.settlementResult === "yes" || event.settlementResult === "no"));
  if (!settlement) return;
  const quotes = observations.filter((row) => {
    const payload = parse(row.payloadJson);
    return payload?.["studyVersion"] === PAIRED_SIDE_STUDY_VERSION
      // Early prospective rows predate observationKind. They are original
      // quotes too; outcome projections are the only excluded row kind.
      && payload["observationKind"] !== "paired_side_settlement_outcome"
      && row.observedAtMs <= settlement.occurredAtMs;
  });
  await Promise.all(quotes.map(async (quote) => {
    const payload = parse(quote.payloadJson);
    if (!payload) return;
    await store.insertEth30ShadowObservation({
      id: `${quote.id}:settlement`,
      ticker,
      observedAtMs: settlement.occurredAtMs,
      payloadJson: JSON.stringify({
        ...payload,
        observationKind: "paired_side_settlement_outcome",
        settlementLabel: settlement.settlementResult,
        settlementObservedAtMs: settlement.occurredAtMs,
        copiedFromObservationId: quote.id,
      }),
    });
  }));
}

/** Read-only status aggregation. Decision labels are joined after capture and
 * never fed back into the observer or order lifecycle. */
export function summarizePairedSideStudy(
  observations: readonly Eth30ShadowObservationParams[],
  decisions: readonly { ticker: string; decision: string; occurredAtMs: number }[],
) {
  const rows = observations.map((row) => ({ row, payload: parse(row.payloadJson) })).filter(
    (entry): entry is { row: Eth30ShadowObservationParams; payload: Record<string, unknown> } =>
      entry.payload?.["studyVersion"] === PAIRED_SIDE_STUDY_VERSION,
  );
  // Early prospective rows predate observationKind. They are still original
  // quotes; only the explicitly appended outcome projection is excluded.
  const quoteRows = rows.filter(({ payload }) => payload["observationKind"] !== "paired_side_settlement_outcome");
  const settlementLabelsByQuoteId = new Map(
    rows
      .filter(({ payload }) => payload["observationKind"] === "paired_side_settlement_outcome"
        && typeof payload["copiedFromObservationId"] === "string"
        && (payload["settlementLabel"] === "yes" || payload["settlementLabel"] === "no"))
      .map(({ payload }) => [payload["copiedFromObservationId"] as string, payload["settlementLabel"]]),
  );
  const payloads = quoteRows.map(({ payload }) => payload);
  const labels = { successfulPairedExecution: 0, freshnessFailure: 0, secondLegBlocked: 0, zeroOrPartialFill: 0, unlabeled: 0 };
  const candidates = quoteRows.filter(({ payload }) => payload["candidateStatus"] === "candidate_with_executable_depth");
  // A durable decision belongs to at most one capture: the closest prior
  // executable candidate in the declared 15-second observation window. This
  // deliberately excludes nearby non-candidates and prevents five-second
  // sampling from multiplying a single execution outcome in the report.
  const associated = new Set<Eth30ShadowObservationParams>();
  for (const decision of decisions) {
    const candidate = candidates
      .filter(({ payload }) => payload["ticker"] === decision.ticker && Number(payload["observedAtMs"]) <= decision.occurredAtMs
        && decision.occurredAtMs - Number(payload["observedAtMs"]) <= 15_000)
      .sort((a, b) => Number(b.payload["observedAtMs"]) - Number(a.payload["observedAtMs"]))[0];
    if (!candidate) continue;
    associated.add(candidate.row);
    if (decision.decision === "paired_entry_completed") labels.successfulPairedExecution++;
    else if (decision.decision === "paired_freshness_failed") labels.freshnessFailure++;
    else if (decision.decision === "paired_second_leg_blocked") labels.secondLegBlocked++;
    else if (decision.decision === "entry_zero_fill" || decision.decision === "entry_error") labels.zeroOrPartialFill++;
  }
  labels.unlabeled = candidates.filter(({ row }) => !associated.has(row)).length;
  const lead = { cheapSide: 0, expensiveSide: 0, ambiguous: 0 };
  for (const row of payloads) {
    if (row["firstObservedReprice"] === "cheap_side") lead.cheapSide++;
    else if (row["firstObservedReprice"] === "expensive_side") lead.expensiveSide++;
    else if (row["firstObservedReprice"] === "simultaneous_or_ambiguous") lead.ambiguous++;
  }
  return {
    id: PAIRED_SIDE_STUDY_VERSION, purpose: "Tests whether the 70–80¢ leg reprices ahead of the complementary 20–30¢ leg.",
    status: payloads.length ? "active_prospective_collection" : "awaiting_first_capture",
    observations: payloads.length, candidateObservations: candidates.length,
    settledOutcomes: candidates.filter(({ row }) => settlementLabelsByQuoteId.has(row.id)).length,
    startAtMs: payloads.length ? Math.min(...payloads.map((row) => Number(row["observedAtMs"]))) : null,
    latestAtMs: payloads.length ? Math.max(...payloads.map((row) => Number(row["observedAtMs"]))) : null,
    repricingLeadCounts: lead, executionLabels: labels,
    preliminaryResult: payloads.length ? "Descriptive only; no causal conclusion or execution recommendation." : "No observations yet.",
    dataQualityLimitations: ["timestamps are source update/receipt precision only", "two IOC outcomes are joined after capture", "settlement is not used as a predictor"],
    actionable: false, nextMilestone: "Collect at least 30 independently settled paired candidates with timestamp-safe transitions.",
  };
}