/**
 * Passive ETH_30_50 shadow research only.
 *
 * This module intentionally has no order, cancel, target, claim, sizing, or
 * authenticated trading-client dependency. It records causal observations and
 * hypothetical signals labelled SHADOW_ONLY_NOT_EXECUTED; callers must invoke
 * it fire-and-forget so telemetry cannot participate in a trade decision.
 */
import { parseExitSellBids, type KalshiOrderbookRaw } from "../orderbookParsing.js";
import type {
  Eth30PositionEventParams, Eth30StrategyOrder, Eth30ShadowEventParams,
  Eth30ShadowObservationParams,
} from "../tradeStore.js";

export type Eth30ShadowSignal = "t_minus_120_adverse_momentum" | "entry_plus_9m_adverse_momentum" | "t_minus_45_bbo_under_15";
export interface Eth30ShadowState { ticker: string; closeTime: string | null; observedAtMs: number; yesBid?: number | null; noBid?: number | null; }
export interface Eth30ShadowStore {
  listEth30StrategyOrders(ticker: string): Promise<Eth30StrategyOrder[]>;
  listEth30PositionEvents(ticker: string): Promise<Eth30PositionEventParams[]>;
  listEth30ShadowObservations(ticker: string, afterMs?: number): Promise<Eth30ShadowObservationParams[]>;
  listEth30ShadowEvents(ticker: string): Promise<Eth30ShadowEventParams[]>;
  insertEth30ShadowObservation(params: Eth30ShadowObservationParams): Promise<boolean>;
  upsertEth30ShadowEvent(params: Eth30ShadowEventParams): Promise<void>;
}
export interface Eth30ShadowDependencies {
  store: Eth30ShadowStore;
  getEthReference(observedAtMs: number): Promise<{ price: number; sourceTimestampMs: number }>;
  fetchOrderbookRaw(ticker: string): Promise<KalshiOrderbookRaw>;
}

const LABEL = "SHADOW_ONLY_NOT_EXECUTED";
const CAPTURE_INTERVAL_MS = 5_000;
const CHECKPOINT_WINDOW_MS = 15_000;
// This observer shares the process with live trading. Gate before *any* store,
// reference, or book request so a burst of market updates cannot amplify API
// reads or leave concurrent detached observers competing with order handling.
const lastCaptureBucketByTicker = new Map<string, number>();
const captureInFlightByTicker = new Map<string, Promise<void>>();

function safeJson(value: string): Record<string, unknown> | null {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null; } catch { return null; }
}
function isEthTicker(ticker: string): boolean { return /^KXETH15M-/.test(ticker); }
function outcomeSummary(orders: Eth30StrategyOrder[], events: Eth30PositionEventParams[]): Record<string, unknown> {
  const target = orders.filter((order) => order.role === "exit" && order.limitPriceCents === 50)
    .reduce((sum, order) => sum + (order.filledContracts ?? 0), 0);
  const settlement = events.find((event) => event.eventType === "settlement");
  const entryCost = events.filter((event) => event.eventType === "entry_fill")
    .reduce((sum, event) => sum + event.contractsDelta * (event.fillPriceCents ?? 0), 0);
  const exitProceeds = events.filter((event) => event.eventType === "exit_fill")
    .reduce((sum, event) => sum + Math.abs(event.contractsDelta) * (event.fillPriceCents ?? 0), 0);
  const entrySide = orders.find((order) => order.role === "entry")?.side;
  const settlementContracts = Math.abs(settlement?.contractsDelta ?? 0);
  const settlementPayout = settlement && settlementResultMatchesHeldSide(settlement.settlementResult, entrySide)
    ? settlementContracts * 100 : 0;
  return {
    actualTarget50FilledContracts: target,
    settlementResult: settlement?.settlementResult ?? null,
    realizedGrossPnlCents: settlement ? exitProceeds + settlementPayout - entryCost : null,
  };
}
function settlementResultMatchesHeldSide(result: string | null | undefined, side: string | undefined): boolean {
  return (result === "yes" || result === "no") && result === side;
}
function checkpointDue(signal: Eth30ShadowSignal, secondsSinceEntry: number, secondsRemaining: number): boolean {
  if (signal === "entry_plus_9m_adverse_momentum") return secondsSinceEntry >= 540 && secondsSinceEntry < 555;
  if (signal === "t_minus_120_adverse_momentum") return secondsRemaining <= 120 && secondsRemaining > 105;
  return secondsRemaining <= 45 && secondsRemaining > 30;
}

export async function observeEth30ShadowTelemetry(deps: Eth30ShadowDependencies, state: Eth30ShadowState): Promise<void> {
  if (!isEthTicker(state.ticker)) return;
  const bucket = Math.floor(state.observedAtMs / CAPTURE_INTERVAL_MS);
  if (lastCaptureBucketByTicker.get(state.ticker) === bucket) return;
  const existing = captureInFlightByTicker.get(state.ticker);
  if (existing) return existing;
  // Mark the bucket at the scheduling boundary, not after the I/O work. A
  // failed passive capture is intentionally dropped rather than retried in a
  // tight loop that could interfere with live order traffic.
  lastCaptureBucketByTicker.set(state.ticker, bucket);
  const work = observeEth30ShadowTelemetryForCapture(deps, state).finally(() => {
    captureInFlightByTicker.delete(state.ticker);
  });
  captureInFlightByTicker.set(state.ticker, work);
  return work;
}

async function observeEth30ShadowTelemetryForCapture(deps: Eth30ShadowDependencies, state: Eth30ShadowState): Promise<void> {
  if (!isEthTicker(state.ticker) || !state.closeTime) return;
  const [orders, events] = await Promise.all([
    deps.store.listEth30StrategyOrders(state.ticker),
    deps.store.listEth30PositionEvents(state.ticker),
  ]);
  const entry = events.filter((event) => event.eventType === "entry_fill").sort((a, b) => a.occurredAtMs - b.occurredAtMs)[0];
  const entryOrder = orders.find((order) => order.role === "entry");
  if (!entry || !entryOrder || (entryOrder.side !== "yes" && entryOrder.side !== "no")) return;
  const closeMs = Date.parse(state.closeTime);
  if (!Number.isFinite(closeMs)) return;
  const openQuantity = events.sort((a, b) => a.occurredAtMs - b.occurredAtMs).at(-1)?.contractsAfter ?? 0;
  // Signals model hypothetical exits of an authenticated *open* holding only.
  // Once a durable exit has reduced ownership to zero, stop before reference,
  // L2, or shadow-event work so post-exit ticks cannot contaminate the cohort.
  if (openQuantity <= 0) return;
  const secondsRemaining = (closeMs - state.observedAtMs) / 1_000;
  const secondsSinceEntry = (state.observedAtMs - entry.occurredAtMs) / 1_000;
  // Continue briefly after close in case the evaluator receives the terminal
  // update before reconciliation appends its dedicated settlement evidence.
  if (secondsSinceEntry < 0 || secondsRemaining < -300) return;

  const [reference, raw, historical] = await Promise.all([
    deps.getEthReference(state.observedAtMs),
    deps.fetchOrderbookRaw(state.ticker),
    // 60 seconds plus one capture interval retains a causal point across
    // normal 5-second sampling jitter and survives a process restart.
    deps.store.listEth30ShadowObservations(state.ticker, state.observedAtMs - 65_000),
  ]);
  const usableHistory = historical.map((row) => safeJson(row.payloadJson))
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter((row) => typeof row["referenceEthUsd"] === "number" && typeof row["observedAtMs"] === "number");
  const prior30 = usableHistory.filter((row) => Number(row["observedAtMs"]) <= state.observedAtMs - 30_000).at(-1);
  const prior60 = usableHistory.filter((row) => Number(row["observedAtMs"]) <= state.observedAtMs - 60_000).at(-1);
  const moveFrom = (prior: Record<string, unknown> | undefined) => typeof prior?.["referenceEthUsd"] === "number"
    ? (reference.price - prior["referenceEthUsd"]) * (entryOrder.side === "yes" ? 1 : -1) : null;
  // Positive is favourable to the held side and negative is adverse for both
  // YES and NO. The raw ETH delta is intentionally not used as a signal field.
  const signedMove30s = moveFrom(prior30);
  const signedMove60s = moveFrom(prior60);
  const adverseMomentum = signedMove30s != null && signedMove30s < 0;
  const levels = parseExitSellBids(raw, entryOrder.side);
  const bestExecutableCents = levels.length ? Math.max(...levels.map((level) => level.priceCents)) : null;
  const executableDepthContracts = levels.reduce((sum, level) => sum + level.contractsApprox, 0);
  const executableContracts = Math.min(Math.max(0, openQuantity), executableDepthContracts);
  const target = orders.find((order) => order.role === "exit" && order.limitPriceCents === 50) ?? null;
  const entryFillPriceCents = entry.fillPriceCents ?? entryOrder.averageFillPriceCents ?? entryOrder.limitPriceCents;
  const outcome = outcomeSummary(orders, events);
  const payload = {
    label: LABEL, ticker: state.ticker, observedAtMs: state.observedAtMs, entryFillAtMs: entry.occurredAtMs,
    heldSide: entryOrder.side, ownedContracts: openQuantity, secondsSinceEntry, secondsRemaining,
    entryFillPriceCents, heldSideBboCents: entryOrder.side === "yes" ? state.yesBid ?? null : state.noBid ?? null,
    target50OrderStatus: target?.outcome ?? "not_posted", target50FilledContracts: target?.filledContracts ?? 0,
    target50RemainingContracts: target ? Math.max(0, target.requestedContracts - (target.filledContracts ?? 0)) : 0,
    referenceEthUsd: reference.price, referenceSourceTimestampMs: reference.sourceTimestampMs,
    signedEthMove30s: signedMove30s, signedEthMove60s: signedMove60s, yesBid: state.yesBid ?? null, noBid: state.noBid ?? null,
    executableSellBestCents: bestExecutableCents, executableSellDepthContracts: executableDepthContracts,
    estimatedExecutableContracts: executableContracts,
    hypotheticalGrossExitValueCents: bestExecutableCents == null ? null : executableContracts * bestExecutableCents,
    hypotheticalGrossExitPnlCents: bestExecutableCents == null ? null : executableContracts * (bestExecutableCents - entryFillPriceCents),
    rawExitBidLevels: levels, ...outcome,
  };
  const observationId = `${state.ticker}:shadow:${Math.floor(state.observedAtMs / CAPTURE_INTERVAL_MS)}`;
  await deps.store.insertEth30ShadowObservation({ id: observationId, ticker: state.ticker, observedAtMs: state.observedAtMs, payloadJson: JSON.stringify(payload) });

  const signals: Array<{ signal: Eth30ShadowSignal; triggered: boolean }> = [
    { signal: "t_minus_120_adverse_momentum", triggered: adverseMomentum },
    { signal: "entry_plus_9m_adverse_momentum", triggered: adverseMomentum },
    { signal: "t_minus_45_bbo_under_15", triggered: bestExecutableCents != null && bestExecutableCents < 15 },
  ];
  const existingEventIds = new Set((await deps.store.listEth30ShadowEvents(state.ticker)).map((event) => event.id));
  for (const candidate of signals) {
    if (!checkpointDue(candidate.signal, secondsSinceEntry, secondsRemaining) || !candidate.triggered) continue;
    const eventId = `${state.ticker}:shadow:${candidate.signal}`;
    // First causal trigger is immutable. refreshEth30ShadowOutcomes() is the
    // sole later writer and updates only eventual outcome fields.
    if (existingEventIds.has(eventId)) continue;
    await deps.store.upsertEth30ShadowEvent({
      id: eventId, ticker: state.ticker, signal: candidate.signal, triggeredAtMs: state.observedAtMs,
      payloadJson: JSON.stringify({ ...payload, signal: candidate.signal, shadowTrigger: true }),
    });
  }
}

/** Refreshes outcomes on already-triggered signals after later fill/settlement evidence arrives. */
export async function refreshEth30ShadowOutcomes(store: Eth30ShadowStore, ticker: string): Promise<void> {
  const [events, orders, positions, observations] = await Promise.all([
    store.listEth30ShadowEvents(ticker), store.listEth30StrategyOrders(ticker), store.listEth30PositionEvents(ticker),
    store.listEth30ShadowObservations(ticker),
  ]);
  const outcome = outcomeSummary(orders, positions);
  await Promise.all(events.map(async (event) => {
    const payload = safeJson(event.payloadJson) ?? {};
    await store.upsertEth30ShadowEvent({ ...event, payloadJson: JSON.stringify({ ...payload, ...outcome }) });
  }));
  const settlement = positions.find((event) => event.eventType === "settlement");
  const lastObservation = observations.at(-1);
  if (settlement && lastObservation) {
    const priorPayload = safeJson(lastObservation.payloadJson) ?? {};
    await store.insertEth30ShadowObservation({
      id: `${ticker}:shadow:settlement`, ticker, observedAtMs: settlement.occurredAtMs,
      payloadJson: JSON.stringify({
        ...priorPayload, ...outcome, observationKind: "settlement_outcome",
        settlementObservedAtMs: settlement.occurredAtMs,
        copiedFromObservationId: lastObservation.id,
        label: LABEL,
      }),
    });
  }
}

export function _resetEth30ShadowTelemetryForTesting(): void {
  lastCaptureBucketByTicker.clear();
  captureInFlightByTicker.clear();
}