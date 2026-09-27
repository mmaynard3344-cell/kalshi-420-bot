/**
 * Frozen v1 BTC/ETH asset-local shadow study.
 *
 * Research only. This module has no order, claim, reservation, balance, auth,
 * route, or execution imports. It receives read-only observations through
 * injected dependencies and writes only isolated shadow telemetry.
 */
export const CROSS_MARKET_SHADOW_STUDY_VERSION = "asset-local-btc-eth-v1";
export const CROSS_MARKET_SHADOW_LABEL = "SHADOW_ONLY_NOT_EXECUTED";
export const CROSS_MARKET_CHECKPOINT_SECONDS = [30, 60, 120, 300, 600] as const;
export const CROSS_MARKET_MIN_P95_HISTORY = 200;
export const CROSS_MARKET_DISLOCATION_CENTS = 8;
export const CROSS_MARKET_ANCHOR_GRACE_SECONDS = 10;
export const CROSS_MARKET_CHECKPOINT_GRACE_SECONDS = 20;
export const CROSS_MARKET_VOL_LOOKBACK_WINDOWS = [8, 32, 96] as const;

export type CrossMarketAsset = "BTC" | "ETH";
export type CrossMarketSide = "yes" | "no";
export type CrossMarketSignalFamily =
  | "reversal_candidate"
  | "continuation_candidate"
  | "dislocation_candidate";

export interface ShadowObservationRow {
  id: string;
  ticker: string;
  observedAtMs: number;
  payloadJson: string;
}
export interface ShadowEventRow {
  id: string;
  ticker: string;
  signal: string;
  triggeredAtMs: number;
  payloadJson: string;
}
export interface CrossMarketShadowStore {
  insertEth30ShadowObservation(row: ShadowObservationRow): Promise<boolean>;
  listEth30ShadowObservations(ticker: string, afterMs?: number): Promise<ShadowObservationRow[]>;
  listCrossMarketShadowAnchors(asset: CrossMarketAsset, beforeMs: number, limit?: number): Promise<ShadowObservationRow[]>;
  listEth30ShadowEvents(ticker: string): Promise<ShadowEventRow[]>;
  upsertEth30ShadowEvent(row: ShadowEventRow): Promise<void>;
}
export interface CrossMarketReference {
  price: number;
  sourceTimestampMs: number;
}
export interface CrossMarketDepth {
  bestAskCents: number | null;
  depthContracts: number | null;
}
export interface CrossMarketShadowDeps {
  store: CrossMarketShadowStore;
  getReference(asset: CrossMarketAsset, observedAtMs: number): Promise<CrossMarketReference>;
  getVisibleDepth(ticker: string, side: CrossMarketSide): Promise<CrossMarketDepth>;
}
export interface CrossMarketShadowInput {
  ticker: string;
  openTime: string | null;
  closeTime: string | null;
  floorStrike: number | null;
  comparisonOperator: ">=" | ">" | "<=" | "<" | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  quoteUpdatedAtMs: number;
  observedAtMs: number;
}

const attempted = new Set<string>();

export function isCrossMarketShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CROSS_MARKET_SHADOW_ENABLED"] === "true";
}

export function assetFromCrossMarketTicker(ticker: string): CrossMarketAsset | null {
  if (/^KXBTC15M-/.test(ticker)) return "BTC";
  if (/^KXETH15M-/.test(ticker)) return "ETH";
  return null;
}

function parsePayload(row: ShadowObservationRow): Record<string, unknown> | null {
  try {
    const value = JSON.parse(row.payloadJson);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function percentile(values: readonly number[], q: number): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const w = pos - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

function standardDeviation(values: readonly number[]): number | null {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  return Math.sqrt(clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (clean.length - 1));
}

function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function frozenBaselineYesProbability(input: {
  referencePrice: number;
  floorStrike: number;
  comparisonOperator: CrossMarketShadowInput["comparisonOperator"];
  completedReturns: readonly number[];
}): number | null {
  if (!(input.referencePrice > 0) || !(input.floorStrike > 0) || !input.comparisonOperator) return null;
  const sigma = standardDeviation(input.completedReturns.slice(-96));
  if (sigma == null || sigma <= 0) return null;
  const z = Math.log(input.referencePrice / input.floorStrike) / sigma;
  const above = normalCdf(z);
  return input.comparisonOperator === ">=" || input.comparisonOperator === ">" ? above : 1 - above;
}

export function classifyPriorWindowCandidateSides(input: {
  completedReturns: readonly number[];
  comparisonOperator: CrossMarketShadowInput["comparisonOperator"];
}): { p95: number | null; reversalSide: CrossMarketSide | null; continuationSide: CrossMarketSide | null } {
  const { completedReturns } = input;
  const priorCompleted15mReturn = completedReturns.length ? completedReturns.at(-1)! : null;
  const p95 = completedReturns.length >= CROSS_MARKET_MIN_P95_HISTORY
    ? percentile(completedReturns.map(Math.abs), .95)
    : null;
  const extreme = p95 != null && priorCompleted15mReturn != null
    ? Math.abs(priorCompleted15mReturn) >= p95
    : false;
  const priorDirection = priorCompleted15mReturn == null || priorCompleted15mReturn === 0
    ? null : priorCompleted15mReturn > 0 ? "up" as const : "down" as const;
  const continuationSide = extreme && priorDirection ? directionSide(priorDirection, input.comparisonOperator) : null;
  const reversalSide = extreme && priorDirection
    ? directionSide(priorDirection === "up" ? "down" : "up", input.comparisonOperator)
    : null;
  return { p95, reversalSide, continuationSide };
}

function directionSide(direction: "up" | "down", operator: CrossMarketShadowInput["comparisonOperator"]): CrossMarketSide | null {
  if (!operator) return null;
  const yesIsUp = operator === ">=" || operator === ">";
  if (direction === "up") return yesIsUp ? "yes" : "no";
  return yesIsUp ? "no" : "yes";
}

function conservativeEntryPrice(input: CrossMarketShadowInput, side: CrossMarketSide): number | null {
  const direct = side === "yes" ? input.yesAsk : input.noAsk;
  const derived = side === "yes"
    ? (input.noBid == null ? null : 100 - input.noBid)
    : (input.yesBid == null ? null : 100 - input.yesBid);
  const values = [direct, derived].filter((value): value is number =>
    value != null && Number.isFinite(value) && value >= 1 && value <= 99);
  return values.length ? Math.max(...values) : null;
}

function yesMid(input: CrossMarketShadowInput): number | null {
  const mids: number[] = [];
  if (input.yesBid != null && input.yesAsk != null) mids.push((input.yesBid + input.yesAsk) / 2);
  if (input.noBid != null && input.noAsk != null) mids.push(100 - (input.noBid + input.noAsk) / 2);
  return mids.length ? mids.reduce((a, b) => a + b, 0) / mids.length : null;
}

function completedReturnSeries(rows: readonly ShadowObservationRow[]): Array<{ openTimeMs: number; price: number }> {
  return rows.map((row) => parsePayload(row))
    .filter((payload): payload is Record<string, unknown> => payload != null
      && payload["studyVersion"] === CROSS_MARKET_SHADOW_STUDY_VERSION
      && payload["observationKind"] === "open_anchor"
      && payload["anchorQuality"] === "on_time"
      && typeof payload["openTimeMs"] === "number"
      && typeof payload["referencePrice"] === "number")
    .map((payload) => ({ openTimeMs: Number(payload["openTimeMs"]), price: Number(payload["referencePrice"]) }))
    .filter((row) => Number.isFinite(row.openTimeMs) && Number.isFinite(row.price) && row.price > 0)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function causalCompletedReturns(rows: readonly ShadowObservationRow[]): number[] {
  const anchors = completedReturnSeries(rows);
  const returns: number[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const prior = anchors[i - 1]!, current = anchors[i]!;
    if (current.openTimeMs - prior.openTimeMs !== 15 * 60_000) continue;
    returns.push((current.price - prior.price) / prior.price);
  }
  return returns;
}

function feeCentsOneContract(priceCents: number): number {
  const p = priceCents / 100;
  return Math.ceil(0.07 * p * (1 - p) * 100);
}

function modeledNetCents(side: CrossMarketSide | null, price: number | null, result: "yes" | "no"): number | null {
  if (!side || price == null) return null;
  const fee = feeCentsOneContract(price);
  return side === result ? 100 - price - fee : -price - fee;
}

function checkpointFor(elapsedSeconds: number): number | null {
  return CROSS_MARKET_CHECKPOINT_SECONDS.find((checkpoint) =>
    elapsedSeconds >= checkpoint && elapsedSeconds < checkpoint + CROSS_MARKET_CHECKPOINT_GRACE_SECONDS) ?? null;
}

async function persistAnchor(
  deps: CrossMarketShadowDeps,
  input: CrossMarketShadowInput,
  asset: CrossMarketAsset,
  openMs: number,
  elapsedSeconds: number,
): Promise<void> {
  if (elapsedSeconds < 0 || elapsedSeconds >= CROSS_MARKET_ANCHOR_GRACE_SECONDS) return;
  const key = `${input.ticker}:cross-market:${CROSS_MARKET_SHADOW_STUDY_VERSION}:anchor`;
  if (attempted.has(key)) return;
  attempted.add(key);
  try {
    const reference = await deps.getReference(asset, input.observedAtMs);
    const sourceAgeMs = input.observedAtMs - reference.sourceTimestampMs;
    const onTime = reference.sourceTimestampMs >= openMs - 5_000
      && reference.sourceTimestampMs <= openMs + CROSS_MARKET_ANCHOR_GRACE_SECONDS * 1_000;
    const inserted = await deps.store.insertEth30ShadowObservation({
      id: key,
      ticker: input.ticker,
      observedAtMs: input.observedAtMs,
      payloadJson: JSON.stringify({
        label: CROSS_MARKET_SHADOW_LABEL,
        studyVersion: CROSS_MARKET_SHADOW_STUDY_VERSION,
        observationKind: "open_anchor",
        asset,
        ticker: input.ticker,
        openTimeMs: openMs,
        referencePrice: reference.price,
        referenceSourceTimestampMs: reference.sourceTimestampMs,
        referenceAgeMs: sourceAgeMs,
        anchorQuality: onTime ? "on_time" : "late_or_noncausal",
      }),
    });
    if (!inserted) {
      const durable = await deps.store.listEth30ShadowObservations(input.ticker)
        .then((rows) => rows.some((row) => row.id === key))
        .catch(() => false);
      if (!durable) attempted.delete(key);
    }
  } catch {
    attempted.delete(key);
  }
}

export async function observeCrossMarketShadowStudy(
  deps: CrossMarketShadowDeps,
  input: CrossMarketShadowInput,
): Promise<void> {
  if (!isCrossMarketShadowEnabled()) return;
  const asset = assetFromCrossMarketTicker(input.ticker);
  if (!asset || !input.openTime || !input.closeTime) return;
  const openMs = Date.parse(input.openTime), closeMs = Date.parse(input.closeTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) return;
  const elapsedSeconds = Math.floor((input.observedAtMs - openMs) / 1_000);
  await persistAnchor(deps, input, asset, openMs, elapsedSeconds);

  const checkpointSeconds = checkpointFor(elapsedSeconds);
  if (checkpointSeconds == null) return;
  const key = `${input.ticker}:cross-market:${CROSS_MARKET_SHADOW_STUDY_VERSION}:cp:${checkpointSeconds}`;
  if (attempted.has(key)) return;
  attempted.add(key);

  try {
    const [reference, yesDepth, noDepth, anchorRows] = await Promise.all([
      deps.getReference(asset, input.observedAtMs),
      deps.getVisibleDepth(input.ticker, "yes"),
      deps.getVisibleDepth(input.ticker, "no"),
      deps.store.listCrossMarketShadowAnchors(asset, input.observedAtMs + 1, 500),
    ]);
    const anchors = completedReturnSeries(anchorRows);
    const completedReturns = causalCompletedReturns(anchorRows);
    const currentAnchor = [...anchors].reverse().find((row) => row.openTimeMs === openMs) ?? null;
    const priorCompleted15mReturn = completedReturns.length ? completedReturns.at(-1)! : null;
    const { p95, reversalSide, continuationSide } = classifyPriorWindowCandidateSides({
      completedReturns,
      comparisonOperator: input.comparisonOperator,
    });

    const baselineYesProbability = frozenBaselineYesProbability({
      referencePrice: reference.price,
      floorStrike: input.floorStrike ?? Number.NaN,
      comparisonOperator: input.comparisonOperator,
      completedReturns,
    });
    const kalshiYesMidCents = yesMid(input);
    const dislocationCents = baselineYesProbability == null || kalshiYesMidCents == null
      ? null : baselineYesProbability * 100 - kalshiYesMidCents;
    const dislocationSide: CrossMarketSide | null = dislocationCents == null || Math.abs(dislocationCents) < CROSS_MARKET_DISLOCATION_CENTS
      ? null : dislocationCents > 0 ? "yes" : "no";

    const modeledEntryPriceCents = {
      yes: conservativeEntryPrice(input, "yes"),
      no: conservativeEntryPrice(input, "no"),
    };
    const payload = {
      label: CROSS_MARKET_SHADOW_LABEL,
      studyVersion: CROSS_MARKET_SHADOW_STUDY_VERSION,
      observationKind: "checkpoint",
      asset,
      signalFamily: "asset_local_frozen_v1",
      checkpointSeconds,
      ticker: input.ticker,
      openTime: input.openTime,
      closeTime: input.closeTime,
      openTimeMs: openMs,
      closeTimeMs: closeMs,
      observedAtMs: input.observedAtMs,
      actualElapsedSeconds: elapsedSeconds,
      floorStrike: input.floorStrike,
      comparisonOperator: input.comparisonOperator,
      yesBidCents: input.yesBid,
      yesAskCents: input.yesAsk,
      noBidCents: input.noBid,
      noAskCents: input.noAsk,
      yesSpreadCents: input.yesBid != null && input.yesAsk != null ? input.yesAsk - input.yesBid : null,
      noSpreadCents: input.noBid != null && input.noAsk != null ? input.noAsk - input.noBid : null,
      yesVisibleDepthContracts: yesDepth.depthContracts,
      noVisibleDepthContracts: noDepth.depthContracts,
      yesL2BestAskCents: yesDepth.bestAskCents,
      noL2BestAskCents: noDepth.bestAskCents,
      quoteAgeMs: Math.max(0, input.observedAtMs - input.quoteUpdatedAtMs),
      referencePrice: reference.price,
      referenceSourceTimestampMs: reference.sourceTimestampMs,
      referenceAgeMs: Math.max(0, input.observedAtMs - reference.sourceTimestampMs),
      returnFloorToReference: input.floorStrike && input.floorStrike > 0 ? (reference.price - input.floorStrike) / input.floorStrike : null,
      returnSinceMarketOpen: currentAnchor ? (reference.price - currentAnchor.price) / currentAnchor.price : null,
      priorCompleted15mReturn,
      trailingAbsReturnP95: p95,
      validPriorWindowCount: completedReturns.length,
      realizedVolatility: Object.fromEntries(CROSS_MARKET_VOL_LOOKBACK_WINDOWS.map((lookback) => [
        `${lookback}x15m`,
        standardDeviation(completedReturns.slice(-lookback)),
      ])),
      kalshiYesMidCents,
      baselineYesProbability,
      baselineModel: "zero_drift_gaussian_prior_15m_realized_sigma_96_windows",
      dislocationCents,
      dislocationThresholdCents: CROSS_MARKET_DISLOCATION_CENTS,
      modeledEntryPriceCents,
      candidateSides: {
        reversal_candidate: reversalSide,
        continuation_candidate: continuationSide,
        dislocation_candidate: dislocationSide,
      },
      candidateFlags: {
        reversal_candidate: reversalSide != null,
        continuation_candidate: continuationSide != null,
        dislocation_candidate: dislocationSide != null,
      },
      frozenRules: {
        p95MinimumPriorValidWindows: CROSS_MARKET_MIN_P95_HISTORY,
        p95Direction: "one_sided_from_prior_completed_return",
        dislocationCents: CROSS_MARKET_DISLOCATION_CENTS,
        conservativeExecutablePrice: "max_direct_ask_and_complementary_derived_ask",
      },
    };
    const inserted = await deps.store.insertEth30ShadowObservation({
      id: key, ticker: input.ticker, observedAtMs: input.observedAtMs, payloadJson: JSON.stringify(payload),
    });
    if (!inserted) {
      const durable = await deps.store.listEth30ShadowObservations(input.ticker)
        .then((rows) => rows.some((row) => row.id === key))
        .catch(() => false);
      if (!durable) {
        attempted.delete(key);
        return;
      }
    }

    const candidates: Array<[CrossMarketSignalFamily, CrossMarketSide | null]> = [
      ["reversal_candidate", reversalSide],
      ["continuation_candidate", continuationSide],
      ["dislocation_candidate", dislocationSide],
    ];
    await Promise.all(candidates.filter(([, side]) => side != null).map(async ([family, side]) => {
      const entry = modeledEntryPriceCents[side!];
      await deps.store.upsertEth30ShadowEvent({
        id: `${key}:${family}`,
        ticker: input.ticker,
        signal: family,
        triggeredAtMs: input.observedAtMs,
        payloadJson: JSON.stringify({
          ...payload,
          signalFamily: family,
          candidateSide: side,
          modeledEntryPriceCents: entry,
        }),
      });
    }));
  } catch {
    attempted.delete(key);
  }
}

export async function refreshCrossMarketShadowSettlement(
  store: CrossMarketShadowStore,
  ticker: string,
  result: "yes" | "no",
  settlementObservedAtMs: number,
): Promise<void> {
  if (!assetFromCrossMarketTicker(ticker)) return;
  const [observations, events] = await Promise.all([
    store.listEth30ShadowObservations(ticker),
    store.listEth30ShadowEvents(ticker),
  ]);
  const checkpoints = observations.filter((row) => {
    const payload = parsePayload(row);
    return payload?.["studyVersion"] === CROSS_MARKET_SHADOW_STUDY_VERSION
      && payload["observationKind"] === "checkpoint";
  });
  await Promise.all(checkpoints.map(async (row) => {
    const payload = parsePayload(row)!;
    const candidateSides = (payload["candidateSides"] ?? {}) as Record<string, CrossMarketSide | null>;
    const prices = (payload["modeledEntryPriceCents"] ?? {}) as Record<CrossMarketSide, number | null>;
    const modeledNetReturnCents = Object.fromEntries(
      (["reversal_candidate", "continuation_candidate", "dislocation_candidate"] as CrossMarketSignalFamily[])
        .map((family) => [family, modeledNetCents(candidateSides[family] ?? null, prices[candidateSides[family] as CrossMarketSide] ?? null, result)]),
    );
    await store.insertEth30ShadowObservation({
      id: `${row.id}:settlement`,
      ticker,
      observedAtMs: settlementObservedAtMs,
      payloadJson: JSON.stringify({
        ...payload,
        observationKind: "settlement_projection",
        authoritativeSettlementResult: result,
        settlementObservedAtMs,
        modeledOneContractNetReturnCents: modeledNetReturnCents,
        modeledFeeAssumption: "ceil_0.07_times_contracts_times_p_times_1_minus_p_to_whole_cent",
        copiedFromObservationId: row.id,
      }),
    });
  }));
  await Promise.all(events.filter((event) => {
    const payload = (() => { try { return JSON.parse(event.payloadJson) as Record<string, unknown>; } catch { return null; } })();
    return payload?.["studyVersion"] === CROSS_MARKET_SHADOW_STUDY_VERSION;
  }).map(async (event) => {
    const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    const side = payload["candidateSide"] === "yes" || payload["candidateSide"] === "no"
      ? payload["candidateSide"] as CrossMarketSide : null;
    const entry = typeof payload["modeledEntryPriceCents"] === "number" ? payload["modeledEntryPriceCents"] : null;
    await store.upsertEth30ShadowEvent({
      ...event,
      payloadJson: JSON.stringify({
        ...payload,
        authoritativeSettlementResult: result,
        settlementObservedAtMs,
        modeledOneContractNetReturnCents: modeledNetCents(side, entry, result),
      }),
    });
  }));
}

export function _resetCrossMarketShadowForTesting(): void {
  attempted.clear();
}
