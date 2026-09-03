/**
 * Isolation tests for the unfinished passive recoverability study.
 *
 * This suite deliberately runs with RECOVERABILITY_CAPTURE_ENABLED unset. It
 * proves the public entrypoints remain inert and it checks the source boundary
 * so this passive module cannot acquire trading behavior by accident.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  enqueueRecoverabilityOutcome,
  enqueueRecoverabilitySnapshot,
  getRecoverabilityCaptureStatus,
  startRecoverabilityCapture,
  type RecoverabilitySnapshot,
} from "./recoverabilityCapture.js";

const snapshot: RecoverabilitySnapshot = {
  timestampMs: 1_700_000_000_000,
  ticker: "KXBTC15M-TEST",
  series: "KXBTC15M",
  closeTime: "2026-08-03T00:00:00.000Z",
  openTime: null,
  expirationTime: null,
  status: "open",
  secondsLeft: 120,
  yesBid: 75,
  yesAsk: 76,
  noBid: 24,
  noAsk: 25,
  bboReceivedMs: 1_700_000_000_000,
  source: "test",
  eventKind: "evaluation",
};

function source(name: string): string {
  return readFileSync(join(process.cwd(), "src", name), "utf8");
}

describe("recoverability capture disabled by default", () => {
  it("does not start a worker, Coinbase socket, queue, file, or SQL activity", () => {
    assert.equal(process.env["RECOVERABILITY_CAPTURE_ENABLED"], undefined);
    const before = getRecoverabilityCaptureStatus();

    assert.doesNotThrow(() => startRecoverabilityCapture());
    assert.doesNotThrow(() => enqueueRecoverabilitySnapshot(snapshot));
    assert.doesNotThrow(() => enqueueRecoverabilityOutcome(snapshot.ticker, "yes"));

    const after = getRecoverabilityCaptureStatus();
    assert.equal(after.started, false);
    assert.equal(after.queueDepth, 0);
    assert.equal(after.queueHighWater, 0);
    assert.equal(after.observations, 0);
    assert.equal(after.spotTicks, 0);
    assert.equal(after.outcomes, 0);
    assert.equal(after.writeFailures, before.writeFailures);
    assert.equal(after.spot.BTC, null);
    assert.equal(after.spot.ETH, null);
  });

  it("keeps the passive worker out of the production startup path", () => {
    const startup = source("index.ts");
    const reconciler = source("lib/outcomeReconciler.ts");
    assert.doesNotMatch(startup, /recoverabilityCapture/);
    assert.doesNotMatch(startup, /startRecoverabilityCapture/);
    assert.match(reconciler, /RECOVERABILITY_CAPTURE_ENABLED"\] === "true"/);
    assert.match(reconciler, /import\("\.\/recoverabilityCapture\.js"\)/);
    assert.doesNotMatch(reconciler, /import \{ enqueueRecoverabilityOutcome \}/);
  });

  it("uses a one-second, not per-websocket-message, persistence cadence", () => {
    const capture = source("lib/recoverabilityCapture.ts");
    assert.match(capture, /const SPOT_INTERVAL_MS = 1_000/);
    assert.match(capture, /lastPersistedSpotSecond/);
    assert.match(capture, /Math\.floor\(tick\.timestampMs \/ SPOT_INTERVAL_MS\)/);
    assert.match(capture, /latestSpot\.set\(asset, tick\)/);
    assert.doesNotMatch(capture, /persistSpot\(\{\s*id: `\$\{product\}/);
  });

  it("contains passive-only imports and non-throwing failure boundaries", () => {
    const capture = source("lib/recoverabilityCapture.ts");
    assert.doesNotMatch(capture, /from ["']\.\/autoTrader(?:\.js)?["']/);
    assert.doesNotMatch(capture, /from ["']\.\/autoTraderGuards(?:\.js)?["']/);
    assert.doesNotMatch(capture, /from ["']\.\/passiveObserver(?:\.js)?["']/);
    assert.doesNotMatch(capture, /from ["']\.\.\/routes\/trade(?:\.js)?["']/);
    assert.match(capture, /if \(!CAPTURE_ENABLED \|\| !started\) return/);
    assert.match(capture, /if \(queue\.length >= MAX_QUEUE\) \{ metrics\.dropped\+\+; return; \}/);
    assert.match(capture, /try \{ append\(/);
    assert.match(capture, /try \{ tradeStore\.insertRecoverability/);
  });
});