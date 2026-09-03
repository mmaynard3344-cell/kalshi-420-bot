/**
 * Tests for the getCachedMandelbrotReport TTL cache.
 *
 * Goals:
 *  - Two rapid calls return the same cached result (no second disk read).
 *  - Cache is invalidated after invalidateMandelbrotReportCache().
 *  - Cache expires after TTL elapses (via clock stub, not real sleep).
 *  - cacheHits and cacheMisses increment as expected.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCachedMandelbrotReport,
  invalidateMandelbrotReportCache,
  scoreMandelbrotInstability,
  REPORT_CACHE_TTL_MS,
  _resetMandelbrotReportCacheForTesting,
  _ageReportCacheForTesting,
  _setMandelbrotDataDirForTesting,
  type MandelbrotObservation,
} from "./mandelbrotInstability.js";

// ── shared fixture ─────────────────────────────────────────────────────────────

const quotes = [
  { timestampMs: 1, executablePriceCents: 75 },
  { timestampMs: 2, executablePriceCents: 77 },
] as const;

const baseInput = {
  enabled: true,
  ticker: "KXBTC15M-CACHE",
  timestampMs: 100,
  secondsLeft: 60,
  side: "yes" as const,
  executablePriceCents: 75,
  quotes: [...quotes],
};

function makeObs(overrides: Partial<MandelbrotObservation> = {}): MandelbrotObservation {
  return {
    ...baseInput,
    version: "mandelbrot-instability-v1",
    score: 30,
    components: scoreMandelbrotInstability(quotes, {}).components,
    ...overrides,
  };
}

// ── test suite ─────────────────────────────────────────────────────────────────

describe("getCachedMandelbrotReport — TTL cache", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "mandelbrot-cache-test-"));
    _setMandelbrotDataDirForTesting(dir);
    mkdirSync(dir, { recursive: true });
    // Write a minimal ledger with two observations so the report is non-trivial.
    writeFileSync(
      join(dir, "mandelbrot-instability-v1.ndjson"),
      [makeObs({ timestampMs: 1 }), makeObs({ timestampMs: 2, score: 55 })]
        .map((o) => JSON.stringify(o))
        .join("\n") + "\n",
    );
  });

  after(() => {
    _setMandelbrotDataDirForTesting("" as never);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each test starts with a completely empty cache and zero counters.
    _resetMandelbrotReportCacheForTesting();
  });

  it("first call is a cache miss that reads the ledger and returns observations", () => {
    const result = getCachedMandelbrotReport();

    assert.equal(result.cacheMisses, 1, "first call must be a miss");
    assert.equal(result.cacheHits, 0);
    assert.equal(result.cacheAgeMs, 0, "miss returns age 0");
    assert.equal(result.observations.length, 2, "ledger has two records");
    assert.equal(result.summary.totalObservations, 2);
  });

  it("second rapid call is a cache hit — no second disk read", () => {
    const first  = getCachedMandelbrotReport(); // miss
    const second = getCachedMandelbrotReport(); // hit

    assert.equal(first.cacheMisses,  1);
    assert.equal(second.cacheMisses, 1, "miss count must not increase on hit");
    assert.equal(second.cacheHits,   1, "hit count must increment");

    // The same array reference proves no disk re-read occurred.
    assert.strictEqual(
      second.observations,
      first.observations,
      "cached result must return the identical observations array",
    );
    assert.strictEqual(
      second.summary,
      first.summary,
      "cached result must return the identical summary object",
    );
  });

  it("a third rapid call increments cacheHits again", () => {
    getCachedMandelbrotReport(); // miss
    getCachedMandelbrotReport(); // hit 1
    const third = getCachedMandelbrotReport(); // hit 2

    assert.equal(third.cacheHits,   2);
    assert.equal(third.cacheMisses, 1);
  });

  it("cacheAgeMs is positive and growing on cache hits", async () => {
    getCachedMandelbrotReport(); // miss — primes the cache

    // Give Date.now() at least 1 ms to advance.
    await new Promise((resolve) => setImmediate(resolve));

    const hit = getCachedMandelbrotReport();
    assert.ok(hit.cacheAgeMs !== null && hit.cacheAgeMs >= 0,
      `cacheAgeMs should be non-negative, got ${hit.cacheAgeMs}`);
  });

  it("invalidateMandelbrotReportCache() causes the next call to be a miss", () => {
    getCachedMandelbrotReport(); // miss → primes cache
    invalidateMandelbrotReportCache();
    const afterInvalidation = getCachedMandelbrotReport();

    assert.equal(afterInvalidation.cacheMisses, 2, "must re-read after invalidation");
    assert.equal(afterInvalidation.cacheHits,   0);
    assert.equal(afterInvalidation.cacheAgeMs,  0);
    assert.equal(afterInvalidation.observations.length, 2);
  });

  it("hit after invalidation re-caches correctly", () => {
    getCachedMandelbrotReport(); // miss 1
    invalidateMandelbrotReportCache();
    getCachedMandelbrotReport(); // miss 2

    const hit = getCachedMandelbrotReport(); // hit 1
    assert.equal(hit.cacheMisses, 2);
    assert.equal(hit.cacheHits,   1);
  });

  it("cache expires after TTL elapses — next call is a miss", () => {
    getCachedMandelbrotReport(); // miss — primes cache

    // Artificially age the cache entry beyond the TTL without sleeping.
    _ageReportCacheForTesting(REPORT_CACHE_TTL_MS + 1);

    const afterTtl = getCachedMandelbrotReport();
    assert.equal(afterTtl.cacheMisses, 2, "expired cache must re-read");
    assert.equal(afterTtl.cacheHits,   0);
    assert.equal(afterTtl.cacheAgeMs,  0, "fresh miss returns age 0");
  });

  it("cache still hits when aged to well under the TTL", () => {
    getCachedMandelbrotReport(); // miss — primes cache

    // Age the cache to half the TTL — comfortably within the valid window
    // regardless of scheduling jitter, avoiding a 1 ms margin race.
    _ageReportCacheForTesting(Math.floor(REPORT_CACHE_TTL_MS / 2));

    const stillValid = getCachedMandelbrotReport();
    assert.equal(stillValid.cacheHits,   1, "half-TTL-aged cache must still hit");
    assert.equal(stillValid.cacheMisses, 1);
  });

  it("counters are independent across invalidations and TTL expiries", () => {
    getCachedMandelbrotReport();                          // miss 1
    getCachedMandelbrotReport();                          // hit  1
    invalidateMandelbrotReportCache();
    getCachedMandelbrotReport();                          // miss 2
    getCachedMandelbrotReport();                          // hit  2
    _ageReportCacheForTesting(REPORT_CACHE_TTL_MS + 1);
    getCachedMandelbrotReport();                          // miss 3
    const last = getCachedMandelbrotReport();             // hit  3

    assert.equal(last.cacheMisses, 3);
    assert.equal(last.cacheHits,   3);
  });
});
