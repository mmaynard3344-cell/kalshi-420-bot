import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetKrakenPricesForTesting, getKrakenPrices } from "../krakenPrices.js";
import { afterEach, beforeEach, describe, it } from "node:test";
import { exportPhase4BNdjson } from "./export.js";
import { normalizePhase4BBook } from "./orderbookSnapshot.js";
import {
  _resetPhase4BForTesting,
  _initializePhase4BSpoolReplayForTesting,
  _setPhase4BReferenceEnricherForTesting,
  _setPhase4BProgramEExternalEvidenceEnricherForTesting,
  _setPhase4BSpoolPathForTesting,
  _setPhase4BWriterForTesting,
  enqueuePhase4BPassiveCapture,
  getPhase4BPassiveCaptureStatus,
  isPhase4BPassiveCaptureEnabled,
  replayPhase4BSpool,
} from "./passiveCapture.js";
import { PROGRAM_E_EXTERNAL_SOURCES } from "./passiveExperimentRegistry.js";
import { buildPhase4BReferenceObservation } from "./referenceFeatures.js";
import type { Phase4BReferenceObservation } from "./types.js";

const input = (overrides: Record<string, unknown> = {}) => ({
  timestampMs: 1_000_000, ticker: "KXBTC15M-26AUG041200-00", series: "KXBTC15M",
  closeTime: new Date(1_120_000).toISOString(), openTime: new Date(220_000).toISOString(),
  secondsLeft: 120, side: "yes" as const, source: "websocket" as const, wsConnected: true, wsStale: false,
  lastWsMessageAgeMs: 10, bboAgeMs: 10, yesBid: 74, yesAsk: 75, noBid: 24, noAsk: 25,
  displayedEntryPriceCents: 76, configuredLimitCents: 76, bboDerivedLimitCents: 76, strategyVersion: "test",
  betDollars: 600, priceFloorCents: 70, priceCapCents: 95, limitBufferCents: 1, staleGapThresholdCents: 2,
  decisionClassification: "skip_stale_bbo_gap", skipReason: "skip_stale_bbo_gap", quotedBboAskCents: 76,
  executableL2AskCents: 79, bboToL2GapCents: 3, preflightLatencyMs: 15, ...overrides,
});

function installOfflineReferenceEnricher(): void {
  _setPhase4BReferenceEnricherForTesting(async (_market, snapshot): Promise<Phase4BReferenceObservation> =>
    buildPhase4BReferenceObservation({
      snapshotId: snapshot.snapshotId, asset: "BTC", source: "test", referencePrice: 65000,
      sourceTimestampMs: snapshot.capturedAtMs, capturedAtMs: snapshot.capturedAtMs,
      history: [], intervalStartMs: null,
    }));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function installTestSpool(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "phase4b-spool-"));
  const path = join(directory, "captures.ndjson");
  _setPhase4BSpoolPathForTesting(path);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

afterEach(() => {
  delete process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"];
  _resetPhase4BForTesting();
  _resetKrakenPricesForTesting();
});

describe("Phase 4B passive capture", () => {
  beforeEach(() => {
    _resetPhase4BForTesting();
  });

  it("is disabled unless the exact string true is set and initializes no work", () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "TRUE";
    assert.equal(isPhase4BPassiveCaptureEnabled(), false);
    enqueuePhase4BPassiveCapture(input());
    assert.equal(getPhase4BPassiveCaptureStatus().accepted, 0);
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    assert.equal(isPhase4BPassiveCaptureEnabled(), true);
  });

  it("uses deterministic baseline identities, deduplicates collisions, and copies inputs", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    const written: Array<Record<string, unknown>> = [];
    _setPhase4BWriterForTesting(async (_market, snapshot) => { written.push(snapshot as unknown as Record<string, unknown>); });
    const first = input();
    enqueuePhase4BPassiveCapture(first);
    enqueuePhase4BPassiveCapture(first);
    (first as { yesBid: number }).yesBid = 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(written.length, 1);
    assert.equal(written[0]?.["yesBid"], 74);
    assert.match(String(written[0]?.["snapshotId"]), /baseline:1000000$/);
    assert.equal(getPhase4BPassiveCaptureStatus().deduped, 1);
  });

  it("retains five-second baseline buckets for non-candidate states and keeps BTC/ETH independent", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    const written: Array<Record<string, unknown>> = [];
    _setPhase4BWriterForTesting(async (_market, snapshot) => { written.push(snapshot as unknown as Record<string, unknown>); });
    for (let secondsLeft = 180; secondsLeft >= 1; secondsLeft--) {
      enqueuePhase4BPassiveCapture(input({
        timestampMs: 1_000_000 + (180 - secondsLeft) * 1_000, secondsLeft,
        displayedEntryPriceCents: null, decisionClassification: "observed_pre_decision", skipReason: null,
      }));
    }
    enqueuePhase4BPassiveCapture(input({ ticker: "KXETH15M-26AUG041200-00", series: "KXETH15M", secondsLeft: 180 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(written.filter((record) => record["marketId"] === "KXBTC15M-26AUG041200-00").length, 36);
    assert.equal(written.filter((record) => record["marketId"] === "KXETH15M-26AUG041200-00").length, 1);
    assert.equal(written[0]?.["decisionClassification"], "observed_pre_decision");
  });

  it("keeps a richer post-preflight event distinct from its baseline bucket", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    const written: Array<Record<string, unknown>> = [];
    _setPhase4BWriterForTesting(async (_market, snapshot) => { written.push(snapshot as unknown as Record<string, unknown>); });
    enqueuePhase4BPassiveCapture(input());
    enqueuePhase4BPassiveCapture(input({ decisionClassification: "skip_stale_bbo_gap" }), "skip_stale_bbo_gap");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(written.length, 2);
    assert.notEqual(written[0]?.["snapshotId"], written[1]?.["snapshotId"]);
  });
  it("persists causal Program E evidence through the real passive capture writer", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    _setPhase4BProgramEExternalEvidenceEnricherForTesting(async (_market, snapshot) =>
      Object.fromEntries(PROGRAM_E_EXTERNAL_SOURCES.map((source) => [source, {
        source, capturedAtMs: snapshot.capturedAtMs, sourceTimestampMs: snapshot.capturedAtMs - 1_000,
        availabilityTimestampMs: snapshot.capturedAtMs, latencyMs: 1_000,
        availability: "available", revisionState: "original", value: 1,
      }])));
    let programE: Record<string, unknown> | undefined;
    _setPhase4BWriterForTesting(async (_market, _snapshot, _books, _reference, _prospective, registry) => {
      programE = registry.find((row) => row["experimentVersion"] === "cross-market-lead-lag-v1");
    });
    enqueuePhase4BPassiveCapture(input());
    await delay(20);
    assert.equal(programE?.["qualification"], "eligible");
    assert.equal(((programE?.["payload"] as Record<string, unknown>)["externalObservations"] as Record<string, { causal: boolean }>).cmeBtcFutures.causal, true);
  });

  it("isolates writer failures from the caller", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    _setPhase4BWriterForTesting(async () => { throw new Error("storage unavailable"); });
    assert.doesNotThrow(() => enqueuePhase4BPassiveCapture(input()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(getPhase4BPassiveCaptureStatus().failed, 1);
  });

  it("retries transient database failures and records the actual error", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    let attempts = 0;
    _setPhase4BWriterForTesting(async () => {
      attempts++;
      if (attempts < 3) throw new Error("timeout exceeded when trying to connect");
    });
    enqueuePhase4BPassiveCapture(input());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = getPhase4BPassiveCaptureStatus();
    assert.equal(attempts, 3);
    assert.equal(status.written, 1);
    assert.equal(status.failed, 2);
    assert.equal(status.retryAttempts, 2);
    assert.match(status.mostRecentWriteError ?? "", /timeout exceeded/i);
  });

  it("does not retry permanent writer failures", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    let attempts = 0;
    _setPhase4BWriterForTesting(async () => {
      attempts++;
      throw new Error("column does not exist");
    });
    enqueuePhase4BPassiveCapture(input());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = getPhase4BPassiveCaptureStatus();
    assert.equal(attempts, 1);
    assert.equal(status.failed, 1);
    assert.equal(status.retryAttempts, 0);
    assert.match(status.mostRecentWriteError ?? "", /column does not exist/i);
  });

  it("spools one valid NDJSON capture after exhausted database retries", async () => {
    const spool = installTestSpool();
    try {
      process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
      installOfflineReferenceEnricher();
      _setPhase4BWriterForTesting(async () => { throw new Error("connection timeout"); });
      enqueuePhase4BPassiveCapture(input());
      await delay(450);
      const lines = readFileSync(spool.path, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]!);
      assert.match(record.captureId, /baseline:1000000$/);
      assert.equal(record.retryCount, 5);
      assert.equal(record.ticker, "KXBTC15M-26AUG041200-00");
      assert.match(record.lastError, /connection timeout/i);
    } finally { spool.cleanup(); }
  });

  it("appends multiple failed captures without overwriting earlier spool records", async () => {
    const spool = installTestSpool();
    try {
      process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
      installOfflineReferenceEnricher();
      _setPhase4BWriterForTesting(async () => { throw new Error("column does not exist"); });
      enqueuePhase4BPassiveCapture(input());
      enqueuePhase4BPassiveCapture(input({ timestampMs: 1_005_000 }));
      await delay(40);
      const records = readFileSync(spool.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(records.length, 2);
      assert.notEqual(records[0].captureId, records[1].captureId);
    } finally { spool.cleanup(); }
  });

  it("initialization replays valid spool records and removes successful records", async () => {
    const spool = installTestSpool();
    try {
      process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
      installOfflineReferenceEnricher();
      _setPhase4BWriterForTesting(async () => { throw new Error("column does not exist"); });
      enqueuePhase4BPassiveCapture(input());
      await delay(25);
      let writes = 0;
      _setPhase4BWriterForTesting(async () => { writes++; });
      _initializePhase4BSpoolReplayForTesting();
      await delay(30);
      assert.equal(writes, 1);
      assert.equal(readFileSync(spool.path, "utf8"), "");
      assert.equal(getPhase4BPassiveCaptureStatus().replayed, 1);
    } finally { spool.cleanup(); }
  });

  it("retains failed replay records and makes repeated replay idempotent", async () => {
    const spool = installTestSpool();
    try {
      process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
      installOfflineReferenceEnricher();
      _setPhase4BWriterForTesting(async () => { throw new Error("column does not exist"); });
      enqueuePhase4BPassiveCapture(input());
      await delay(25);
      const original = readFileSync(spool.path, "utf8");
      let writes = 0;
      _setPhase4BWriterForTesting(async () => { writes++; throw new Error("column does not exist"); });
      await replayPhase4BSpool();
      assert.equal(readFileSync(spool.path, "utf8"), original);
      _setPhase4BWriterForTesting(async () => { writes++; });
      await replayPhase4BSpool();
      await replayPhase4BSpool();
      assert.equal(writes, 2);
      assert.equal(readFileSync(spool.path, "utf8"), "");
    } finally { spool.cleanup(); }
  });

  it("serializes concurrent replay calls and preserves malformed spool lines", async () => {
    const spool = installTestSpool();
    try {
      process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
      installOfflineReferenceEnricher();
      _setPhase4BWriterForTesting(async () => { throw new Error("column does not exist"); });
      enqueuePhase4BPassiveCapture(input());
      await delay(25);
      writeFileSync(spool.path, `not-json\n${readFileSync(spool.path, "utf8")}`, "utf8");
      let writes = 0;
      _setPhase4BWriterForTesting(async () => { writes++; await delay(10); });
      await Promise.all([replayPhase4BSpool(), replayPhase4BSpool()]);
      assert.equal(writes, 1);
      assert.equal(readFileSync(spool.path, "utf8").trim(), "not-json");
    } finally { spool.cleanup(); }
  });

  it("handles missing and empty spool files safely", async () => {
    const spool = installTestSpool();
    try {
      await replayPhase4BSpool();
      assert.equal(existsSync(spool.path), true);
      writeFileSync(spool.path, "", "utf8");
      await replayPhase4BSpool();
      assert.equal(readFileSync(spool.path, "utf8"), "");
    } finally { spool.cleanup(); }
  });

  it("normalizes bounded two-sided books deterministically", () => {
    const raw = { orderbook_fp: {
      yes_dollars: [["0.20", "10"], ["0.30", "5"], ["0.20", "2"]] as [string, string][],
      no_dollars: [["0.40", "7"], ["0.10", "11"]] as [string, string][],
    } };
    const yes = normalizePhase4BBook(raw, "yes", "s", 70, 1, 4);
    const no = normalizePhase4BBook(raw, "no", "s", 80, 1, 4);
    assert.deepEqual(yes.levels.map((level) => level.priceCents), [60, 90]);
    assert.equal(yes.executableContracts, 7);
    assert.deepEqual(no.levels.map((level) => level.priceCents), [70, 80]);
    assert.equal(no.totalRetainedContracts, 17);
  });

  it("calculates reference features causally and preserves missing reference state", () => {
    const history = [
      { timestampMs: 700_000, price: 90 }, { timestampMs: 940_000, price: 100 },
      { timestampMs: 970_000, price: 110 }, { timestampMs: 1_000_001, price: 999 },
    ];
    const result = buildPhase4BReferenceObservation({
      snapshotId: "s", asset: "BTC", source: "test", referencePrice: 120, sourceTimestampMs: 1_000_000,
      capturedAtMs: 1_000_000, history, intervalStartMs: 700_000,
    });
    assert.ok(Math.abs(result.return5s! - (120 / 110 - 1)) < 1e-12);
    assert.ok(Math.abs(result.return15s! - (120 / 110 - 1)) < 1e-12);
    assert.ok(Math.abs(result.return30s! - (120 / 110 - 1)) < 1e-12);
    assert.ok(Math.abs(result.return60s! - (120 / 100 - 1)) < 1e-12);
    assert.ok(Math.abs(result.return5m! - (120 / 90 - 1)) < 1e-12);
    assert.equal(result.direction, "up");
    const missing = buildPhase4BReferenceObservation({
      snapshotId: "m", asset: "BTC", source: "test", referencePrice: null, sourceTimestampMs: null,
      capturedAtMs: 1, history: [], intervalStartMs: null,
    });
    assert.equal(missing.error, "missing_reference_price");
    assert.equal(missing.return5s, null);
    assert.equal(missing.return30s, null);
    const future = buildPhase4BReferenceObservation({
      snapshotId: "future", asset: "BTC", source: "test", referencePrice: 120, sourceTimestampMs: 1_000_001,
      capturedAtMs: 1_000_000, history, intervalStartMs: null,
    });
    assert.equal(future.error, "future_reference_timestamp");
    assert.equal(future.return15s, null);
  });

  it("emits a versioned falling-knife record with trigger-time facts only", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    _setPhase4BReferenceEnricherForTesting(async (_market, snapshot) => ({
      ...buildPhase4BReferenceObservation({
        snapshotId: snapshot.snapshotId, asset: "BTC", source: "test", referencePrice: 100,
        sourceTimestampMs: snapshot.capturedAtMs, capturedAtMs: snapshot.capturedAtMs,
        history: [{ timestampMs: snapshot.capturedAtMs - 5_000, price: 98 }], intervalStartMs: null,
      }),
    }));
    const written: Array<readonly Record<string, unknown>[]> = [];
    _setPhase4BWriterForTesting(async (_market, _snapshot, _books, _reference, prospective) => { written.push(prospective as unknown as readonly Record<string, unknown>[]); });
    enqueuePhase4BPassiveCapture(input({ clientOrderId: "attempt-1", kalshiOrderId: "kalshi-1", side: "yes", displayedEntryPriceCents: 75 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(written.length, 1);
    const fallingKnife = written[0]!.find((record) => record["hypothesisVersion"] === "falling-knife-adverse-move-v1");
    assert.equal(fallingKnife?.["id"], "KXBTC15M-26AUG041200-00:baseline:1000000:falling-knife-adverse-move-v1");
    assert.equal(fallingKnife?.["qualification"], "eligible");
    assert.equal(fallingKnife?.["triggerPriceCents"], 75);
    assert.ok(Math.abs(Number(fallingKnife?.["referenceReturn5s"]) - (100 / 98 - 1)) < 1e-12);
    assert.equal(fallingKnife?.["postStartMs"], null);
    assert.equal(fallingKnife?.["ackMs"], null);
    assert.equal(fallingKnife?.["gapBucketExpected"], "unknown");
  });

  it("retains authoritative rules and derives signed YES/NO cushion only from causal proxy data", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    _setPhase4BReferenceEnricherForTesting(async (_market, snapshot) =>
      buildPhase4BReferenceObservation({
        snapshotId: snapshot.snapshotId, asset: "BTC", source: "kraken", referencePrice: 110,
        sourceTimestampMs: snapshot.capturedAtMs, capturedAtMs: snapshot.capturedAtMs,
        history: [
          { timestampMs: snapshot.capturedAtMs - 30_000, price: 100 },
          { timestampMs: snapshot.capturedAtMs - 15_000, price: 108 },
        ], intervalStartMs: null,
      }));
    const written: Array<readonly Record<string, unknown>[]> = [];
    _setPhase4BWriterForTesting(async (_market, _snapshot, _books, _reference, prospective) => {
      written.push(prospective as unknown as readonly Record<string, unknown>[]);
    });
    const thresholdRule = {
      captureVersion: "distance-to-beat-prospective-v1" as const, source: "kalshi_market_api_snapshot" as const,
      observedAtMs: 999_990, floorStrike: 100, comparisonOperator: ">=" as const,
      rulesPrimary: "BTC settles at or above $100.", rulesSecondary: "Kalshi rules", rulesHash: "test", unavailableReason: null,
    };
    enqueuePhase4BPassiveCapture(input({ thresholdRule, side: "yes", displayedEntryPriceCents: 92 }));
    enqueuePhase4BPassiveCapture(input({ timestampMs: 1_005_000, thresholdRule, side: "no", displayedEntryPriceCents: 93 }));
    await delay(10);
    const records = written.flat().filter((record) => record["hypothesisVersion"] === "distance-to-beat-prospective-v1");
    assert.equal(records.length, 2);
    assert.equal(records[0]?.["qualification"], "measurable");
    assert.equal(records[0]?.["signedCushionDollars"], 10);
    assert.equal(records[0]?.["percentCushion"], 10);
    assert.equal(records[0]?.["movement15sTowardOrAway"], "away");
    assert.ok(Number(records[0]?.["cushionOver30sMovement"]) > 0);
    assert.equal(records[0]?.["causal30sAnchorPrice"], 100);
    assert.equal(records[0]?.["causal30sAnchorSourceTimestampMs"], 970_000);
    assert.equal(records[0]?.["causal30sAnchorStatus"], "available");
    assert.equal(records[1]?.["signedCushionDollars"], -10);
    assert.equal(records[1]?.["movement15sTowardOrAway"], "toward");
    assert.equal((records[0]?.["thresholdRule"] as Record<string, unknown>)["rulesPrimary"], "BTC settles at or above $100.");
  });

  it("marks missing authoritative metadata unavailable without inferring a threshold", async () => {
    process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"] = "true";
    installOfflineReferenceEnricher();
    let distance: Record<string, unknown> | undefined;
    _setPhase4BWriterForTesting(async (_market, _snapshot, _books, _reference, prospective) => {
      distance = (prospective as unknown as readonly Record<string, unknown>[]).find((record) =>
        record["hypothesisVersion"] === "distance-to-beat-prospective-v1");
    });
    enqueuePhase4BPassiveCapture(input());
    await delay(10);
    assert.equal(distance?.["qualification"], "unavailable");
    assert.equal(distance?.["signedCushionDollars"], null);
    assert.match(String(distance?.["reason"]), /metadata_not_available/);
  });

  it("reuses a fresh Kraken cache and retains independent BTC/ETH/SOL raw values", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ result: {
        XXBTZUSD: { c: ["65000"] }, XETHZUSD: { c: ["3500"] }, SOLUSD: { c: ["150"] },
      } }), { status: 200 });
    };
    try {
      const first = await getKrakenPrices(1_000);
      const second = await getKrakenPrices(2_000);
      assert.equal(first.btc, 65000);
      assert.equal(first.eth, 3500);
      assert.equal(first.sol, 150);
      assert.equal(second.cached, true);
      assert.equal(calls, 1);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("keeps explicit provider failures and stale states rather than fabricating a price", () => {
    const failed = buildPhase4BReferenceObservation({
      snapshotId: "failed", asset: "ETH", source: "kraken", referencePrice: null, sourceTimestampMs: null,
      capturedAtMs: 1, error: "reference_fetch_error", history: [], intervalStartMs: null,
    });
    assert.equal(failed.error, "reference_fetch_error");
    assert.equal(failed.referencePrice, null);
    const stale = buildPhase4BReferenceObservation({
      snapshotId: "stale", asset: "BTC", source: "kraken", referencePrice: null, sourceTimestampMs: 1,
      capturedAtMs: 20_000, error: "stale_reference_price", stale: true, cacheAgeMs: 19_999, history: [], intervalStartMs: null,
    });
    assert.equal(stale.stale, true);
    assert.equal(stale.cacheAgeMs, 19_999);
  });

  it("exports stable chronological NDJSON and a deterministic manifest", () => {
    const records = [
      { recordType: "outcome", capturedAtMs: 2, marketId: "b", snapshotId: null, payload: { result: null } },
      { recordType: "decision", capturedAtMs: 1, marketId: "a", snapshotId: "a:1", payload: { x: 1 } },
    ];
    const first = exportPhase4BNdjson(records);
    const second = exportPhase4BNdjson([...records].reverse());
    assert.equal(first.ndjson, second.ndjson);
    assert.equal(first.manifest.digestSha256, second.manifest.digestSha256);
    assert.equal(first.manifest.unresolvedOutcomes, 1);
    assert.match(first.ndjson.split("\n")[0]!, /"capturedAtMs":1/);
  });

  it("does not import live order, auth, route, fill, or submission modules", () => {
    const source = [
      readFileSync(join(process.cwd(), "src/lib/phase4b/passiveCapture.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/lib/phase4b/orderbookSnapshot.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/lib/phase4b/referenceFeatures.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/lib/phase4b/export.ts"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(source, /from\s+["'][^"']*(autoTrader|kalshiAuth|routes|fillReconciler|trade\.ts|submitOrder|placeOrder)[^"']*["']/);
  });
});