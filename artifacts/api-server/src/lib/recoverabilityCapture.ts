/**
 * Passive recoverability study capture.
 *
 * This module is deliberately isolated from order evaluation.  Callers only
 * copy a snapshot into a bounded in-memory queue; all provider I/O, joins,
 * disk work, and SQL work happen later in this worker.  Queue pressure drops
 * research data rather than affecting trading.
 *
 * Spot source: Coinbase Advanced Trade public websocket, BTC-USD / ETH-USD
 * best-bid/best-ask midpoint.  It is explicitly a proxy, never an official
 * CF Benchmarks settlement source.  Kalshi's finalized result is authoritative.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { easternDay } from "./dailyBudget.js";
import { logger } from "./logger.js";
import * as tradeStore from "./tradeStore.js";

const DATA_DIR = join(process.cwd(), "data", "recoverability");
const MAX_QUEUE = 2_000;
const OBS_INTERVAL_MS = 5_000;
const SPOT_INTERVAL_MS = 1_000;
const STALE_SPOT_MS = 5_000;
const COINBASE_WS = "wss://advanced-trade-ws.coinbase.com";
const PRODUCTS = ["BTC-USD", "ETH-USD"] as const;
type Asset = "BTC" | "ETH";
type Side = "yes" | "no";
// This worker writes normalized raw BTC/ETH spot ticks and is retained only for
// historical replay compatibility. New research uses the standalone compact
// derived collector; an operator must opt into legacy raw capture explicitly.
const CAPTURE_ENABLED = process.env["LEGACY_RAW_RESEARCH_CAPTURE_ENABLED"] === "true"
  && process.env["RECOVERABILITY_CAPTURE_ENABLED"] === "true";

export interface RecoverabilitySnapshot {
  timestampMs: number;
  ticker: string;
  series: string;
  closeTime: string | null;
  openTime: string | null;
  expirationTime: string | null;
  status: string | null;
  secondsLeft: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  bboReceivedMs: number;
  source: string;
  eventKind: "evaluation" | "timer" | "preflight" | "order_attempt" | "order_outcome";
  eventDetail?: string | null;
  selectedSide?: Side | null;
  selectedPriceCents?: number | null;
  floorStrike?: number | null;
  rulesPrimary?: string | null;
  rulesSecondary?: string | null;
}

interface SpotTick {
  id: string; timestampMs: number; asset: Asset; provider: string; rawSymbol: string;
  bid: number | null; ask: number | null; midpoint: number | null; receiptMs: number;
  isProxy: boolean; methodology: string;
}
interface Observation extends RecoverabilitySnapshot {
  id: string; observationNumberInWindow: number; asset: Asset;
  windowId: string; yesImplied: number | null; noImplied: number | null;
  selectedImplied: number | null; spot: SpotTick | null; spotAgeMs: number | null;
  comparisonOperator: string | null; settlementSource: string | null;
  rulesHash: string; qualityFlags: string[];
}
interface Outcome {
  ticker: string; result: Side; finalizedAtMs: number; reportedSettlementValue: number | null;
}
type QueueItem = { type: "snapshot"; value: RecoverabilitySnapshot } | { type: "outcome"; value: Outcome };

const queue: QueueItem[] = [];
const latestSpot = new Map<Asset, SpotTick>();
const observationsByTicker = new Map<string, Observation[]>();
const spotByAsset = new Map<Asset, SpotTick[]>();
const lastPersistedSpotSecond = new Map<Asset, number>();
const lastObservationMs = new Map<string, number>();
const observationSequence = new Map<string, number>();
const latestMarket = new Map<string, RecoverabilitySnapshot>();
const metrics = {
  queueHighWater: 0, dropped: 0, writeFailures: 0, feedDisconnects: 0,
  cadenceGaps: 0, observations: 0, spotTicks: 0, outcomes: 0,
};
let started = false;
let ws: WebSocket | null = null;
let processing = false;

function assetFor(series: string): Asset | null {
  if (series.includes("BTC")) return "BTC";
  if (series.includes("ETH")) return "ETH";
  return null;
}
function file(kind: string, ms: number) {
  return join(DATA_DIR, `${kind}-${easternDay(new Date(ms))}.ndjson`);
}
function append(kind: string, ms: number, value: unknown) {
  appendFileSync(file(kind, ms), `${JSON.stringify(value)}\n`, "utf8");
}
function hashRules(a: string | null | undefined, b: string | null | undefined): string {
  let h = 2166136261;
  for (const char of `${a ?? ""}\n${b ?? ""}`) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16);
}
function operatorFromRules(rules: string): string | null {
  if (/\bat or above\b|\bgreater than or equal\b|>=/i.test(rules)) return ">=";
  if (/\bat or below\b|\bless than or equal\b|<=/i.test(rules)) return "<=";
  if (/\babove\b|\bgreater than\b/i.test(rules)) return ">";
  if (/\bbelow\b|\bless than\b/i.test(rules)) return "<";
  return null;
}
function settlementSourceFromRules(rules: string): string | null {
  const match = rules.match(/CF Benchmarks[^.\n]*/i);
  return match?.[0] ?? null;
}
function enqueue(item: QueueItem): void {
  if (!CAPTURE_ENABLED || !started) return;
  if (queue.length >= MAX_QUEUE) { metrics.dropped++; return; }
  queue.push(item);
  metrics.queueHighWater = Math.max(metrics.queueHighWater, queue.length);
}

/** Constant-time, non-awaited market snapshot enqueue for the trading runtime. */
export function enqueueRecoverabilitySnapshot(snapshot: RecoverabilitySnapshot): void {
  try { enqueue({ type: "snapshot", value: { ...snapshot } }); } catch { /* passive capture must not propagate */ }
}
/** Constant-time, non-awaited authoritative outcome enqueue. */
export function enqueueRecoverabilityOutcome(
  ticker: string, result: Side, reportedSettlementValue: number | null = null,
): void {
  try {
    enqueue({ type: "outcome", value: { ticker, result, finalizedAtMs: Date.now(), reportedSettlementValue } });
  } catch { /* passive capture must not propagate */ }
}
export function getRecoverabilityCaptureStatus() {
  const now = Date.now();
  return {
    ...metrics, queueDepth: queue.length, started,
    provider: "Coinbase Advanced Trade public websocket",
    providerKind: "proxy",
    spot: Object.fromEntries(["BTC", "ETH"].map((asset) => {
      const tick = latestSpot.get(asset as Asset);
      return [asset, tick ? { ageMs: now - tick.receiptMs, midpoint: tick.midpoint, stale: now - tick.receiptMs > STALE_SPOT_MS } : null];
    })),
  };
}

function persistSpot(tick: SpotTick) {
  const second = Math.floor(tick.timestampMs / SPOT_INTERVAL_MS);
  if (lastPersistedSpotSecond.get(tick.asset) === second) return;
  lastPersistedSpotSecond.set(tick.asset, second);
  const list = spotByAsset.get(tick.asset) ?? [];
  list.push(tick);
  if (list.length > 2_000) list.splice(0, list.length - 2_000);
  spotByAsset.set(tick.asset, list);
  latestSpot.set(tick.asset, tick);
  try { append("recoverability-spot-ticks", tick.timestampMs, tick); } catch { metrics.writeFailures++; }
  try { tradeStore.insertRecoverabilitySpotTickInSql(tick as unknown as Record<string, unknown>); } catch { metrics.writeFailures++; }
  metrics.spotTicks++;
}
function processSnapshot(s: RecoverabilitySnapshot) {
  latestMarket.set(s.ticker, s);
  const asset = assetFor(s.series);
  if (!asset || !s.closeTime || s.secondsLeft == null || s.secondsLeft <= 0) return;
  const last = lastObservationMs.get(s.ticker) ?? 0;
  if (s.eventKind !== "evaluation" && s.timestampMs - last < OBS_INTERVAL_MS) return;
  if (last && s.timestampMs - last > OBS_INTERVAL_MS * 2) metrics.cadenceGaps++;
  lastObservationMs.set(s.ticker, s.timestampMs);
  const windowId = `${s.series}@${s.closeTime}`;
  const next = (observationSequence.get(windowId) ?? 0) + 1;
  observationSequence.set(windowId, next);
  const spot = latestSpot.get(asset) ?? null;
  const allRules = `${s.rulesPrimary ?? ""}\n${s.rulesSecondary ?? ""}`;
  const selectedPrice = s.selectedPriceCents ?? null;
  const obs: Observation = {
    ...s, id: `${s.ticker}@${s.timestampMs}@${next}`, asset, windowId,
    observationNumberInWindow: next,
    yesImplied: s.noBid == null ? null : (100 - s.noBid) / 100,
    noImplied: s.yesBid == null ? null : (100 - s.yesBid) / 100,
    selectedImplied: selectedPrice == null ? null : selectedPrice / 100,
    spot, spotAgeMs: spot ? s.timestampMs - spot.receiptMs : null,
    comparisonOperator: operatorFromRules(allRules),
    settlementSource: settlementSourceFromRules(allRules),
    rulesHash: hashRules(s.rulesPrimary, s.rulesSecondary),
    qualityFlags: [
      ...(spot ? [] : ["spot_missing"]),
      ...(spot && s.timestampMs - spot.receiptMs > STALE_SPOT_MS ? ["spot_stale"] : []),
      ...(s.floorStrike == null ? ["strike_missing"] : []),
    ],
  };
  const records = observationsByTicker.get(s.ticker) ?? [];
  records.push(obs);
  observationsByTicker.set(s.ticker, records);
  try { append("recoverability-observations", obs.timestampMs, obs); } catch { metrics.writeFailures++; }
  try { tradeStore.insertRecoverabilityObservationInSql(obs as unknown as Record<string, unknown>); } catch { metrics.writeFailures++; }
  metrics.observations++;
}
function processOutcome(outcome: Outcome) {
  const market = latestMarket.get(outcome.ticker);
  const asset = market ? assetFor(market.series) : null;
  const raw = { ...outcome, official: true, market: market ?? null };
  try { append("recoverability-market-outcomes", outcome.finalizedAtMs, raw); } catch { metrics.writeFailures++; }
  try { tradeStore.insertRecoverabilityOutcomeInSql(raw); } catch { metrics.writeFailures++; }
  const observations = observationsByTicker.get(outcome.ticker) ?? [];
  const spots = asset ? (spotByAsset.get(asset) ?? []) : [];
  for (const obs of observations) {
    const after = spots.filter((tick) => tick.timestampMs >= obs.timestampMs);
    const strike = obs.floorStrike;
    const crossed = strike == null ? null : after.some((tick) =>
      outcome.result === "yes" ? (tick.midpoint ?? -Infinity) >= strike : (tick.midpoint ?? Infinity) <= strike);
    const finalSpot = after.at(-1)?.midpoint ?? null;
    const finishedOpposite = strike == null || finalSpot == null ? null :
      outcome.result === "yes" ? finalSpot < strike : finalSpot > strike;
    const label = {
      id: `${obs.id}@${outcome.result}`, observationId: obs.id, ticker: obs.ticker,
      generatedAtMs: outcome.finalizedAtMs, labelVersion: "proxy-cross-v1",
      proxyTouchedOrCrossedStrikeAfter: crossed,
      proxyFinishedOppositeSideAtClose: finishedOpposite,
      estimated60SecondProxyAverage: null,
      officialSettlementResult: outcome.result,
    };
    try { append("recoverability-labels", outcome.finalizedAtMs, label); } catch { metrics.writeFailures++; }
    try { tradeStore.insertRecoverabilityLabelInSql(label); } catch { metrics.writeFailures++; }
  }
  metrics.outcomes++;
}
function drain() {
  if (processing) return;
  processing = true;
  try {
    for (let i = 0; i < 100 && queue.length; i++) {
      const item = queue.shift()!;
      if (item.type === "snapshot") processSnapshot(item.value);
      else processOutcome(item.value);
    }
  } catch (err) {
    metrics.writeFailures++;
    logger.warn({ err }, "recoverabilityCapture: passive worker write failed");
  } finally { processing = false; }
}
function connectSpotFeed() {
  try {
    ws = new WebSocket(COINBASE_WS);
    ws.on("open", () => ws?.send(JSON.stringify({
      type: "subscribe", product_ids: PRODUCTS, channel: "ticker_batch",
    })));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const events = msg["events"] as Array<Record<string, unknown>> | undefined;
        for (const event of events ?? []) for (const ticker of (event["tickers"] as Array<Record<string, unknown>> | undefined) ?? []) {
          const product = String(ticker["product_id"] ?? "");
          const asset = product.startsWith("BTC") ? "BTC" : product.startsWith("ETH") ? "ETH" : null;
          if (!asset) continue;
          const bid = Number(ticker["best_bid"]); const ask = Number(ticker["best_ask"]);
          if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
          const now = Date.now();
          const tick: SpotTick = {
            id: `${product}@${now}`, timestampMs: now, asset, provider: "Coinbase Advanced Trade",
            rawSymbol: product, bid, ask, midpoint: (bid + ask) / 2, receiptMs: now,
            isProxy: true, methodology: "public ticker_batch best-bid/best-ask midpoint",
          };
          // Raw feed traffic updates only an in-memory latest quote. The timer
          // below retains at most one record per asset per wall-clock second.
          latestSpot.set(asset, tick);
        }
      } catch { metrics.writeFailures++; }
    });
    ws.on("close", () => {
      metrics.feedDisconnects++;
      setTimeout(connectSpotFeed, 5_000).unref();
    });
    ws.on("error", () => { /* close handles reconnect */ });
  } catch {
    metrics.feedDisconnects++;
    setTimeout(connectSpotFeed, 5_000).unref();
  }
}
/** Starts the worker; it never invokes market/order APIs. */
export function startRecoverabilityCapture(): void {
  if (!CAPTURE_ENABLED) return;
  if (started) return;
  started = true;
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* worker will report write failure */ }
  setInterval(drain, 100).unref();
  setInterval(() => {
    const now = Date.now();
    for (const asset of ["BTC", "ETH"] as const) {
      const tick = latestSpot.get(asset);
      if (tick) persistSpot({ ...tick, id: `${tick.rawSymbol}@${now}`, timestampMs: now, receiptMs: now });
    }
    for (const market of latestMarket.values()) enqueue({ type: "snapshot", value: { ...market, timestampMs: now, eventKind: "timer" } });
  }, SPOT_INTERVAL_MS).unref();
  connectSpotFeed();
  logger.info({ provider: "Coinbase Advanced Trade", proxy: true }, "recoverabilityCapture: passive worker started");
}