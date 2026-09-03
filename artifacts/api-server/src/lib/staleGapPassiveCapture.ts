/**
 * Opt-in, passive capture for stale-BBO preflight skips.
 *
 * This module is never imported by autoTrader directly. A dynamic importer
 * supplies immutable snapshots only after the live preflight decision is final.
 * It owns no trading state and imports no order, budget, position, or dedup APIs.
 */

import type { L2Level } from "./orderbookParsing.js";
import {
  calculateStaleGapCounterfactual,
  type StaleGapCounterfactualInput,
  type StaleGapCounterfactualResult,
} from "./staleGapCounterfactual.js";

export const STALE_GAP_CAPTURE_MAX_QUEUE = 1_000;

export interface StaleGapPassiveCaptureInput {
  timestampMs: number;
  ticker: string;
  series: string;
  side: "yes" | "no";
  secondsLeft: number;
  bboDerivedLimitCents: number;
  quotedBboAsk: number | null;
  bboAgeMs: number;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  executableBestAskCents: number | null;
  bboToL2GapCents: number | null;
  l2Levels: readonly Readonly<L2Level>[];
  l2FetchLatencyMs: number;
  source: string;
  strategy: Readonly<StaleGapCounterfactualInput["strategy"]>;
  budget: Readonly<StaleGapCounterfactualInput["budget"]>;
  exposure: Readonly<StaleGapCounterfactualInput["exposure"]>;
}

export interface StaleGapPassiveCaptureRecord extends StaleGapPassiveCaptureInput {
  captureId: string;
  passiveOnly: true;
  orderSubmissionAttempted: false;
  counterfactual: StaleGapCounterfactualResult;
}

const queue: StaleGapPassiveCaptureRecord[] = [];
let draining = false;
const metrics = {
  written: 0,
  failed: 0,
  dropped: 0,
  queueHighWater: 0,
  lastSuccessfulWriteAtMs: null as number | null,
  lastErrorAtMs: null as number | null,
};
let persist: (record: StaleGapPassiveCaptureRecord) => Promise<void> = async (record) => {
  const store = await import("./tradeStore.js");
  await store.insertStaleGapCounterfactualCaptureInSql({
    captureId: record.captureId,
    timestampMs: record.timestampMs,
    ticker: record.ticker,
    series: record.series,
    side: record.side,
    payload: record as unknown as Record<string, unknown>,
  });
};

function cloneRecord(input: Readonly<StaleGapPassiveCaptureInput>): StaleGapPassiveCaptureRecord {
  const counterfactual = calculateStaleGapCounterfactual({
    side: input.side,
    bboDerivedLimitCents: input.bboDerivedLimitCents,
    l2Levels: input.l2Levels,
    strategy: { ...input.strategy },
    budget: { ...input.budget },
    exposure: { ...input.exposure },
  });
  return {
    ...input,
    l2Levels: input.l2Levels.map((level) => ({ ...level })),
    strategy: { ...input.strategy },
    budget: { ...input.budget },
    exposure: { ...input.exposure },
    captureId: `${input.ticker}:${input.side}:${input.timestampMs}`,
    passiveOnly: true,
    orderSubmissionAttempted: false,
    counterfactual,
  };
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const record = queue.shift();
      if (!record) continue;
      try {
        await persist(record);
        metrics.written++;
        metrics.lastSuccessfulWriteAtMs = Date.now();
      } catch {
        metrics.failed++;
        metrics.lastErrorAtMs = Date.now();
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Synchronous, bounded, non-throwing enqueue. It starts asynchronous disk work
 * without returning or exposing a promise to the trading runtime.
 */
export function enqueueStaleGapPassiveCapture(input: Readonly<StaleGapPassiveCaptureInput>): void {
  try {
    if (queue.length >= STALE_GAP_CAPTURE_MAX_QUEUE) {
      metrics.dropped++;
      return;
    }
    queue.push(cloneRecord(input));
    metrics.queueHighWater = Math.max(metrics.queueHighWater, queue.length);
    void drain();
  } catch {
    metrics.failed++;
    metrics.lastErrorAtMs = Date.now();
  }
}

export function getStaleGapPassiveCaptureStatus() {
  return {
    enabled: process.env["STALE_GAP_COUNTERFACTUAL_CAPTURE_ENABLED"] === "true",
    queueDepth: queue.length,
    draining,
    ...metrics,
  };
}

/** Test-only reset; no production caller uses this. */
export async function _resetStaleGapPassiveCaptureForTesting(): Promise<void> {
  queue.length = 0;
  draining = false;
  metrics.written = 0;
  metrics.failed = 0;
  metrics.dropped = 0;
  metrics.queueHighWater = 0;
  metrics.lastSuccessfulWriteAtMs = null;
  metrics.lastErrorAtMs = null;
  persist = async (record) => {
    const store = await import("./tradeStore.js");
    await store.insertStaleGapCounterfactualCaptureInSql({
      captureId: record.captureId,
      timestampMs: record.timestampMs,
      ticker: record.ticker,
      series: record.series,
      side: record.side,
      payload: record as unknown as Record<string, unknown>,
    });
  };
}

/** Test-only persistence seam. */
export function _setStaleGapPassiveCaptureWriterForTesting(
  writer: (record: StaleGapPassiveCaptureRecord) => Promise<void>,
): void {
  persist = writer;
}