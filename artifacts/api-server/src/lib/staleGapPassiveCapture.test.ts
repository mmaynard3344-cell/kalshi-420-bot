import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  _resetStaleGapPassiveCaptureForTesting,
  _setStaleGapPassiveCaptureWriterForTesting,
  enqueueStaleGapPassiveCapture,
  getStaleGapPassiveCaptureStatus,
  STALE_GAP_CAPTURE_MAX_QUEUE,
  type StaleGapPassiveCaptureInput,
} from "./staleGapPassiveCapture.js";
import { calculateStaleGapCounterfactual } from "./staleGapCounterfactual.js";

type MutableCaptureInput = Omit<StaleGapPassiveCaptureInput, "strategy" | "budget" | "exposure"> & {
  strategy: { betDollars: number; priceFloorCents?: number; priceCapCents?: number; limitPriceBufferCents?: number };
  budget: { windowRemainingDollars: number; dailyRemainingNotionalCents: number };
  exposure: { signedContracts: number; maxAbsoluteContracts?: number | null };
};

const mutableInput: MutableCaptureInput = {
  timestampMs: 1_700_000_000_000,
  ticker: "KXBTC15M-TEST",
  series: "KXBTC15M",
  side: "no",
  secondsLeft: 60,
  bboDerivedLimitCents: 81,
  quotedBboAsk: 80,
  bboAgeMs: 1,
  yesBid: 20, yesAsk: 21, noBid: 79, noAsk: 80,
  executableBestAskCents: 83,
  bboToL2GapCents: 3,
  l2Levels: [{ priceCents: 83, contractsApprox: 10, notionalDollars: 8.3 }],
  l2FetchLatencyMs: 1,
  source: "test",
  strategy: { betDollars: 100, priceFloorCents: 70, priceCapCents: 95 },
  budget: { windowRemainingDollars: 100, dailyRemainingNotionalCents: 10_000 },
  exposure: { signedContracts: 0, maxAbsoluteContracts: null },
};
const input: StaleGapPassiveCaptureInput = mutableInput;

describe("stale-gap passive capture", () => {
  it("copies its input, is non-blocking, and bounds burst memory", async () => {
    await _resetStaleGapPassiveCaptureForTesting();
    let release!: () => void;
    _setStaleGapPassiveCaptureWriterForTesting(() => new Promise<void>((resolve) => { release = resolve; }));
    const before = structuredClone(input);
    for (let i = 0; i < STALE_GAP_CAPTURE_MAX_QUEUE + 50; i++) {
      enqueueStaleGapPassiveCapture({ ...input, timestampMs: input.timestampMs + i });
    }
    assert.deepEqual(input, before);
    const status = getStaleGapPassiveCaptureStatus();
    assert.ok(status.queueHighWater <= STALE_GAP_CAPTURE_MAX_QUEUE);
    assert.ok(status.dropped >= 1);
    assert.equal(status.written, 0);
    release();
    await _resetStaleGapPassiveCaptureForTesting();
  });

  it("has no live trading imports or mutation dependencies", async () => {
    const source = await readFile(join(process.cwd(), "src/lib/staleGapPassiveCapture.ts"), "utf8");
    assert.doesNotMatch(source, /autoTrader(?:\.js)?["']/);
    assert.doesNotMatch(source, /routes\/trade/);
    assert.doesNotMatch(source, /reserveNotional|claimOrderSlot|placeOrder|getSignedPosition/);
  });

  it("persists the approved calculator result and immutable copied snapshots", async () => {
    await _resetStaleGapPassiveCaptureForTesting();
    const saved: unknown[] = [];
    _setStaleGapPassiveCaptureWriterForTesting(async (record) => { saved.push(structuredClone(record)); });
    const expected = calculateStaleGapCounterfactual({
      side: input.side,
      bboDerivedLimitCents: input.bboDerivedLimitCents,
      l2Levels: input.l2Levels,
      strategy: input.strategy,
      budget: input.budget,
      exposure: input.exposure,
    });
    enqueueStaleGapPassiveCapture(input);
    mutableInput.strategy.betDollars = 1;
    mutableInput.budget.windowRemainingDollars = 1;
    mutableInput.exposure.signedContracts = 99;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(saved.length, 1);
    const record = saved[0] as { counterfactual: unknown; strategy: unknown; budget: unknown; exposure: unknown };
    assert.deepEqual(record.counterfactual, expected);
    assert.deepEqual(record.strategy, { betDollars: 100, priceFloorCents: 70, priceCapCents: 95 });
    assert.deepEqual(record.budget, { windowRemainingDollars: 100, dailyRemainingNotionalCents: 10_000 });
    assert.deepEqual(record.exposure, { signedContracts: 0, maxAbsoluteContracts: null });
    assert.equal(getStaleGapPassiveCaptureStatus().written, 1);
    mutableInput.strategy.betDollars = 100;
    mutableInput.budget.windowRemainingDollars = 100;
    mutableInput.exposure.signedContracts = 0;
  });

  it("contains database failures and reports failure metrics", async () => {
    await _resetStaleGapPassiveCaptureForTesting();
    _setStaleGapPassiveCaptureWriterForTesting(async () => { throw new Error("database unavailable"); });
    enqueueStaleGapPassiveCapture(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = getStaleGapPassiveCaptureStatus();
    assert.equal(status.failed, 1);
    assert.equal(status.written, 0);
    assert.ok(status.lastErrorAtMs);
  });
});