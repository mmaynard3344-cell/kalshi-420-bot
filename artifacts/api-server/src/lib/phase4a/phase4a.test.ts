import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeStaleGapCapture, readStaleGapCapturesFromNdjson } from "./captureReader.js";
import { replayResultToJson, replaySummaryToText } from "./export.js";
import { partitionChronologically, runReplay } from "./replay.js";

const basePayload = (overrides: Record<string, unknown> = {}) => ({
  captureId: "BTC-1",
  timestampMs: Date.UTC(2026, 7, 4, 15),
  easternDate: "2026-08-04",
  ticker: "KXBTC15M-TEST",
  series: "KXBTC15M",
  side: "yes",
  secondsLeft: 90,
  bboToL2GapCents: 4,
  quotedBboAsk: 75,
  yesBid: 73,
  counterfactual: { hypotheticalLimitCents: 74, finalHypotheticalContracts: 10, executableDepthContracts: 12, executableDepthDollars: 8.88 },
  ...overrides,
});

describe("Phase 4A offline replay", () => {
  it("normalizes and replays capture exports deterministically", () => {
    const ndjson = `${JSON.stringify(basePayload())}\n`;
    const captures = readStaleGapCapturesFromNdjson(ndjson);
    const experiment = { id: "baseline", feeDollarsPerContract: 0.01 };
    const first = runReplay(captures, new Map([[captures[0]!.ticker, "yes"]]), experiment);
    const second = runReplay(captures, new Map([[captures[0]!.ticker, "yes"]]), experiment);
    assert.equal(replayResultToJson(first), replayResultToJson(second));
    assert.match(replaySummaryToText(first), /net P&L/i);
  });

  it("calculates cost, fees, payout, P&L, and net ROI for a resolved capture", () => {
    const capture = normalizeStaleGapCapture(basePayload());
    const result = runReplay([capture], new Map([[capture.ticker, "yes"]]), { id: "fees", feeDollarsPerContract: 0.01 });
    const trade = result.trades[0]!;
    assert.equal(trade.entryCostDollars, 7.4);
    assert.equal(trade.feeDollars, 0.1);
    assert.equal(trade.payoutDollars, 10);
    assert.equal(trade.grossPnlDollars, 2.6);
    assert.equal(trade.netPnlDollars, 2.5);
    assert.equal(trade.roi, 2.5 / 7.4);
  });

  it("keeps missing outcomes explicitly unresolved", () => {
    const capture = normalizeStaleGapCapture(basePayload());
    const trade = runReplay([capture], new Map(), { id: "unresolved" }).trades[0]!;
    assert.equal(trade.unresolved, true);
    assert.equal(trade.netPnlDollars, null);
    assert.equal(trade.payoutDollars, null);
  });

  it("deduplicates ticker candidates in chronological order", () => {
    const early = normalizeStaleGapCapture(basePayload({ captureId: "early", timestampMs: 10 }));
    const late = normalizeStaleGapCapture(basePayload({ captureId: "late", timestampMs: 20 }));
    const trades = runReplay([late, early], new Map([[early.ticker, "no"]]), { id: "dedup", oneTradePerMarket: true }).trades;
    assert.equal(trades[0]!.captureId, "early");
    assert.equal(trades[0]!.accepted, true);
    assert.equal(trades[1]!.deduped, true);
  });

  it("splits train and test strictly by historical timestamp", () => {
    const partition = partitionChronologically([{ timestampMs: 20 }, { timestampMs: 10 }, { timestampMs: 30 }], 20);
    assert.deepEqual(partition.train.map((item) => item.timestampMs), [10, 20]);
    assert.deepEqual(partition.test.map((item) => item.timestampMs), [30]);
  });

  it("contains no order-submission imports or calls", async () => {
    const source = await Promise.all([
      readFile(join(process.cwd(), "src/lib/phase4a/captureReader.ts"), "utf8"),
      readFile(join(process.cwd(), "src/lib/phase4a/replay.ts"), "utf8"),
      readFile(join(process.cwd(), "src/lib/phase4a/export.ts"), "utf8"),
    ]);
    for (const file of source) {
      assert.doesNotMatch(file, /autoTrader|kalshiAuthFetch|\/trade\/order|placeOrder|submitOrder/i);
    }
  });
});