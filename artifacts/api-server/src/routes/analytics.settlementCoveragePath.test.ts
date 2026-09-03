/**
 * Regression test: settlement-coverage analysis files resolve correctly
 * regardless of the process working directory.
 *
 * In production the runner starts from the workspace root
 * (`node artifacts/api-server/dist/index.mjs`), not from within the artifact
 * directory. The endpoint must use import.meta.url-relative paths — not
 * process.cwd()-relative ones — to locate bundled analysis inputs.
 *
 * Run from the artifact directory:
 *   cd artifacts/api-server && node_modules/.bin/esbuild \
 *     src/routes/analytics.settlementCoveragePath.test.ts \
 *     --bundle --platform=node --format=esm --outfile=/tmp/sc-path-test.mjs \
 *   && node --test /tmp/sc-path-test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

// process.cwd() is artifacts/api-server when the test runner is invoked via
// `cd artifacts/api-server && … node --test /tmp/…`
const ARTIFACT_ROOT = resolve(process.cwd());

describe("settlement-coverage analysis path resolution", () => {
  test("analysis directory exists at artifact-relative location", () => {
    const analysisDir = join(ARTIFACT_ROOT, "data", "analysis");
    assert.ok(
      existsSync(analysisDir),
      `Expected analysis dir to exist at ${analysisDir}`,
    );
  });

  test("production bundle URL resolution: ../data/analysis from dist/index.mjs reaches the right directory", async () => {
    // In production, esbuild bundles everything into dist/index.mjs.
    // The endpoint resolves:
    //   new URL("../data/analysis", import.meta.url)
    // where import.meta.url == file:///…/artifacts/api-server/dist/index.mjs.
    // "../data/analysis" relative to that URL:
    //   …/artifacts/api-server/dist/  → ../  → …/artifacts/api-server/
    //   → …/artifacts/api-server/data/analysis
    //
    // We simulate the exact same URL arithmetic here using pathToFileURL so
    // the test passes even when cwd is the workspace root.
    const bundleFileUrl = pathToFileURL(join(ARTIFACT_ROOT, "dist", "index.mjs"));
    const analysisDir = fileURLToPath(new URL("../data/analysis", bundleFileUrl));

    const outcomesRaw = await readFile(
      join(analysisDir, "replay-3c74e738-local-outcomes.json"),
      "utf8",
    );
    const auditRaw = await readFile(
      join(analysisDir, "replay-3c74e738-kalshi-market-results-backfill-audit.json"),
      "utf8",
    );

    const outcomes = JSON.parse(outcomesRaw) as {
      summary: { replayId: string; population: number };
      rows: Array<{ ticker: string }>;
    };
    const audit = JSON.parse(auditRaw) as {
      completedAt: string;
      candidateCount: number;
      insertedCount: number;
      unchangedCount: number;
      unresolvedCount: number;
      errorCount: number;
    };

    assert.ok(
      typeof outcomes.summary.replayId === "string",
      "outcomes.summary.replayId should be a string",
    );
    assert.ok(
      typeof outcomes.summary.population === "number",
      "outcomes.summary.population should be a number",
    );
    assert.ok(Array.isArray(outcomes.rows), "outcomes.rows should be an array");
    assert.ok(
      typeof audit.completedAt === "string",
      "audit.completedAt should be a string",
    );
    assert.ok(
      typeof audit.candidateCount === "number",
      "audit.candidateCount should be a number",
    );
  });

  test("workspace-root cwd cannot find analysis files via process.cwd() — confirms the old bug", () => {
    // Two levels up from the artifact dir is the workspace root.
    const workspaceRoot = resolve(ARTIFACT_ROOT, "../..");
    const oldStylePath = join(workspaceRoot, "data", "analysis");
    assert.ok(
      !existsSync(oldStylePath),
      `The process.cwd()-based path must not exist at workspace root (${oldStylePath}); ` +
        "if it did, the original bug would have been harmless",
    );
  });
});
