import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMandelbrotObservation,
  buildMandelbrotReportSummary,
  captureMandelbrotFromLiveObservation,
  captureMandelbrotInstability,
  compactMandelbrotObservationsIfNeeded,
  loadMandelbrotObservations,
  parseNdjsonLine,
  readNdjsonLinesSync,
  reportMandelbrotInstability,
  scoreMandelbrotInstability,
  _resetMandelbrotPathsForTesting,
  _setMandelbrotDataDirForTesting,
  type MandelbrotCaptureInput,
  type MandelbrotObservation,
} from "./mandelbrotInstability.js";

const quotes = [
  { timestampMs: 1, executablePriceCents: 80, spreadCents: 1, executableDepthContracts: 10, quoteAgeMs: 20 },
  { timestampMs: 2, executablePriceCents: 82, spreadCents: 2, executableDepthContracts: 7, quoteAgeMs: 50 },
  { timestampMs: 3, executablePriceCents: 80, spreadCents: 3, executableDepthContracts: 4, quoteAgeMs: 100, realizedVolatility: 0.2 },
] as const;
const input: MandelbrotCaptureInput = {
  enabled: true, ticker: "KXBTC15M-TEST", timestampMs: 1, secondsLeft: 60, side: "yes",
  executablePriceCents: 80, quotes, spreadCents: 3, executableDepthContracts: 4,
};

describe("Mandelbrot Instability V1", () => {
  it("is deterministic and inclusive 0–100", () => {
    const first = scoreMandelbrotInstability(quotes, input);
    assert.deepStrictEqual(first, scoreMandelbrotInstability(quotes, input));
    assert.ok(first.score >= 0 && first.score <= 100);
    assert.equal(scoreMandelbrotInstability([], {}).score, 0);
  });
  it("is disabled by default, eligible only for BTC/ETH 15m final window, and writer failures are isolated", async () => {
    let calls = 0;
    assert.equal(await captureMandelbrotInstability({ ...input, enabled: false }, () => { calls += 1; }), false);
    assert.equal(await captureMandelbrotInstability({ ...input, ticker: "KXSPY15M-TEST" }, () => { calls += 1; }), false);
    assert.equal(await captureMandelbrotInstability({ ...input, secondsLeft: 29 }, () => { calls += 1; }), false);
    assert.equal(await captureMandelbrotInstability({ ...input, secondsLeft: 121 }, () => { calls += 1; }), false);
    assert.equal(calls, 0, "capture only calls its injected passive writer");
    assert.equal(await captureMandelbrotInstability(input, () => { throw new Error("storage down"); }), false);
  });
  it("keeps a local quote path and writes only through the injected passive writer", async () => {
    _resetMandelbrotPathsForTesting();
    const persisted: MandelbrotObservation[] = [];
    assert.equal(await captureMandelbrotFromLiveObservation({ ...input, secondsLeft: 120 }, (record) => { persisted.push(record); }), true);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].quotes.length, 1);
    assert.equal(await captureMandelbrotFromLiveObservation({ ...input, timestampMs: 2, secondsLeft: 30, executablePriceCents: 81 }, (record) => { persisted.push(record); }), true);
    assert.equal(persisted[1].quotes.length, 2);
    assert.equal(persisted[1].spreadQuality ?? "unavailable", "unavailable");
    assert.equal(persisted[1].depthQuality ?? "unavailable", "unavailable");
  });
  it("reports bucket evidence honestly, including unknown outcomes", () => {
    const record = (score: number, overrides: Partial<MandelbrotObservation> = {}): MandelbrotObservation => ({
      ...input, version: "mandelbrot-instability-v1", score, components: scoreMandelbrotInstability(quotes, input).components, ...overrides,
    });
    const report = reportMandelbrotInstability([
      record(85, { filled: true, settled: true, won: true, fallingKnife: true, finalExecutablePriceCents: 84, netPnlDollars: 5, roi: 0.1 }),
      record(85, { filled: true, settled: true, won: false, fallingKnife: false, finalExecutablePriceCents: 82, netPnlDollars: -2, roi: -0.04 }),
      record(10),
    ]);
    const high = report.find((bucket) => bucket.label === "80-100")!;
    assert.deepStrictEqual(
      {
        samples: high.sampleCount, fills: high.filledCount, win: high.winRate,
        loss: high.lossRate, adverse: high.adverseMoveRate, knife: high.fallingKnifeRate,
        move: high.averagePreflightToFinalMoveCents, pnl: high.netPnlDollars, roi: high.roi,
      },
      { samples: 2, fills: 2, win: 0.5, loss: 0.5, adverse: 0.5, knife: 0.5, move: 3, pnl: 3, roi: 0.030000000000000002 },
    );
    const low = report.find((bucket) => bucket.label === "0-19")!;
    assert.equal(low.winRate, null);
    assert.equal(low.netPnlDollars, null);
  });
  it("reports fill evidence independently from unavailable movement evidence", () => {
    const record: MandelbrotObservation = {
      ...input,
      version: "mandelbrot-instability-v1",
      score: 85,
      components: scoreMandelbrotInstability(quotes, input).components,
      spreadQuality: "bbo_derived",
      depthQuality: "unavailable",
      filled: true,
      fillsReconciled: true,
      settled: true,
      won: false,
      netPnlDollars: -3,
      roi: -0.05,
      finalExecutablePriceCents: null,
      fallingKnife: null,
    };
    const high = reportMandelbrotInstability([record]).find((bucket) => bucket.label === "80-100")!;
    assert.equal(high.winRate, 0);
    assert.equal(high.netPnlDollars, -3);
    assert.equal(high.adverseMoveRate, null);
    assert.equal(high.fallingKnifeRate, null);
    const summary = buildMandelbrotReportSummary([record]);
    assert.deepStrictEqual(summary.spreadQualityCounts, { bbo_derived: 1, l2_snapshot: 0, unavailable: 0 });
    assert.equal(summary.reconciliationCompleteness, 1);
  });
  it("recovers valid records after a malformed prefix and keeps new rows compact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mandelbrot-ledger-"));
    const previousDirectory = process.env["MANDELBROT_DATA_DIR"];
    process.env["MANDELBROT_DATA_DIR"] = directory;
    try {
      const original: MandelbrotObservation = {
        ...input,
        version: "mandelbrot-instability-v1",
        score: 25,
        components: scoreMandelbrotInstability(quotes, input).components,
      };
      const newer = { ...original, timestampMs: 2 };
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "mandelbrot-instability-v1.ndjson"),
        `version https://git-lfs.github.com/spec/v1\noid sha256:abc\n${JSON.stringify(newer)}\n`,
      );

      // A pure LFS pointer line is malformed, but it must not hide the valid
      // record after it.
      assert.deepStrictEqual(loadMandelbrotObservations().map((record) => record.timestampMs), [2]);

      appendMandelbrotObservation({ ...original, timestampMs: 3 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const persisted = readFileSync(join(directory, "mandelbrot-instability-v1.ndjson"), "utf8");
      assert.match(persisted, /"quoteCount":3/);
      assert.doesNotMatch(persisted.split("\n").at(-2) ?? "", /"quotes":/);
      assert.match(readFileSync(join(directory, "mandelbrot-instability-v1-paths.ndjson"), "utf8"), /"quote":/);
      assert.deepStrictEqual(loadMandelbrotObservations().map((record) => record.timestampMs).sort((a, b) => a - b), [2, 3]);
    } finally {
      if (previousDirectory === undefined) delete process.env["MANDELBROT_DATA_DIR"];
      else process.env["MANDELBROT_DATA_DIR"] = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("discards an oversized malformed row and resumes at the next record", () => {
    const directory = mkdtempSync(join(tmpdir(), "mandelbrot-ledger-"));
    const previousDirectory = process.env["MANDELBROT_DATA_DIR"];
    process.env["MANDELBROT_DATA_DIR"] = directory;
    try {
      const record: MandelbrotObservation = {
        ...input,
        timestampMs: 99,
        version: "mandelbrot-instability-v1",
        score: 25,
        components: scoreMandelbrotInstability(quotes, input).components,
      };
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "mandelbrot-instability-v1.ndjson"),
        Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 0x78), Buffer.from(`\n${JSON.stringify(record)}\n`)]),
      );
      assert.deepStrictEqual(loadMandelbrotObservations().map((item) => item.timestampMs), [99]);
    } finally {
      if (previousDirectory === undefined) delete process.env["MANDELBROT_DATA_DIR"];
      else process.env["MANDELBROT_DATA_DIR"] = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Mandelbrot ledger durability", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mandelbrot-test-"));
    _setMandelbrotDataDirForTesting(dir);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeObs = (overrides: Partial<MandelbrotObservation> = {}): MandelbrotObservation => ({
    ...input,
    version: "mandelbrot-instability-v1",
    score: 50,
    components: scoreMandelbrotInstability(quotes, input).components,
    ...overrides,
  });
  const ledgerPath = () => join(dir, "mandelbrot-instability-v1.ndjson");

  it("streams lines without loading the whole file and skips oversized lines", () => {
    const p = join(dir, "stream.ndjson");
    const big = "x".repeat(9 * 1024 * 1024); // exceeds MAX_LINE_BYTES
    writeFileSync(p, `a\n${big}\nb\nc`);
    assert.deepStrictEqual([...readNdjsonLinesSync(p)], ["a", "b", "c"]);
  });

  it("salvages a Git-LFS pointer fragment fused to an observation", () => {
    const fused = `version https://git-lfs.github.com/spec/v1 oid sha256:abc size 12345${JSON.stringify(makeObs({ timestampMs: 77 }))}`;
    const rec = parseNdjsonLine<MandelbrotObservation>(fused);
    assert.equal(rec?.timestampMs, 77);
    assert.equal(parseNdjsonLine("total garbage"), null);
  });

  it("a malformed line cannot hide valid later observations from the report", () => {
    mkdirSync(dir, { recursive: true });
    const lfsFused = `version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 999${JSON.stringify(makeObs({ timestampMs: 1 }))}`;
    writeFileSync(ledgerPath(), [
      lfsFused,
      "{ broken json",
      JSON.stringify(makeObs({ timestampMs: 2 })),
      JSON.stringify(makeObs({ timestampMs: 3, side: "no" })),
    ].join("\n") + "\n");
    const loaded = loadMandelbrotObservations();
    assert.deepStrictEqual(
      loaded.map((o) => o.timestampMs).sort((a, b) => a - b),
      [1, 2, 3],
    );
  });

  it("compaction strips old quote paths, keeps recent ones, and bounds the file", () => {
    const now = 1_755_000_000_000;
    const oldObs = makeObs({ timestampMs: now - 600_000 });
    const recentObs = makeObs({ timestampMs: now - 10_000 });
    writeFileSync(ledgerPath(), `${JSON.stringify(oldObs)}\n${JSON.stringify(recentObs)}\n`);
    const before = statSync(ledgerPath()).size;

    // Below threshold: untouched
    assert.equal(compactMandelbrotObservationsIfNeeded(before + 1, now), false);
    // Above threshold: rewritten
    assert.equal(compactMandelbrotObservationsIfNeeded(1, now), true);

    const rewritten = readFileSync(ledgerPath(), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as MandelbrotObservation);
    assert.equal(rewritten.length, 2);
    assert.equal(rewritten[0].timestampMs, oldObs.timestampMs);
    assert.deepStrictEqual(rewritten[0].quotes, [], "old records lose their quote path");
    assert.equal(rewritten[1].quotes.length, quotes.length, "recent records keep their quote path");
    assert.ok(statSync(ledgerPath()).size < before);
    // Report still sees both records after compaction
    assert.equal(loadMandelbrotObservations().length, 2);
    // Missing file is a clean no-op
    rmSync(ledgerPath());
    assert.equal(compactMandelbrotObservationsIfNeeded(1, now), false);
  });
});
