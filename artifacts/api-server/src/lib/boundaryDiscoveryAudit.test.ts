import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadRecentBoundaryDiscoveryTimelines,
  recordBoundaryDiscoveryAudit,
} from "./boundaryDiscoveryAudit.js";

test("boundary discovery timelines retain valid events and ignore a corrupted record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boundary-discovery-audit-"));
  const originalDirectory = process.env["BOUNDARY_DISCOVERY_DATA_DIR"];
  process.env["BOUNDARY_DISCOVERY_DATA_DIR"] = directory;
  try {
    const openTimeMs = Date.parse("2026-08-30T12:00:00.000Z");
    const ticker = "KXETH15M-26AUG300800-00";
    recordBoundaryDiscoveryAudit({ ticker, openTimeMs, atMs: openTimeMs - 2_000, stage: "upcoming_seen", reason: null });
    recordBoundaryDiscoveryAudit({ ticker, openTimeMs, atMs: openTimeMs + 1_000, stage: "executor_blocked", reason: "execution_not_permitted" });
    await writeFile(
      join(directory, "boundary-discovery-2026-08-30.ndjson"),
      "{ malformed evidence line }\n",
      { flag: "a" },
    );

    const report = await loadRecentBoundaryDiscoveryTimelines();
    assert.equal(report.available, true);
    assert.equal(report.timelines.length, 1);
    assert.equal(report.timelines[0]?.ticker, ticker);
    assert.deepEqual(
      report.timelines[0]?.events.map((event) => event.stage),
      ["upcoming_seen", "executor_blocked"],
    );
    assert.equal(report.timelines[0]?.metadataState, "not_applicable");
    assert.equal(report.timelines[0]?.events[1]?.reason, "execution_not_permitted");
  } finally {
    if (originalDirectory === undefined) delete process.env["BOUNDARY_DISCOVERY_DATA_DIR"];
    else process.env["BOUNDARY_DISCOVERY_DATA_DIR"] = originalDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("boundary discovery report retains a fresh response time when metadata is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boundary-discovery-audit-"));
  const originalDirectory = process.env["BOUNDARY_DISCOVERY_DATA_DIR"];
  process.env["BOUNDARY_DISCOVERY_DATA_DIR"] = directory;
  try {
    const openTimeMs = Date.parse("2026-08-30T12:15:00.000Z");
    const responseAtMs = openTimeMs + 750;
    recordBoundaryDiscoveryAudit({
      ticker: "KXETH15M-26AUG300815-15",
      openTimeMs,
      atMs: responseAtMs,
      stage: "active_response",
      reason: null,
    });

    const report = await loadRecentBoundaryDiscoveryTimelines();
    const timeline = report.timelines[0];
    assert.equal(report.available, true);
    assert.equal(timeline?.metadataState, "unavailable");
    assert.deepEqual(timeline?.events, [{
      ticker: "KXETH15M-26AUG300815-15",
      openTimeMs,
      atMs: responseAtMs,
      stage: "active_response",
      reason: null,
    }]);
  } finally {
    if (originalDirectory === undefined) delete process.env["BOUNDARY_DISCOVERY_DATA_DIR"];
    else process.env["BOUNDARY_DISCOVERY_DATA_DIR"] = originalDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("boundary discovery report explicitly marks an unreadable ledger unavailable", async () => {
  const originalDirectory = process.env["BOUNDARY_DISCOVERY_DATA_DIR"];
  process.env["BOUNDARY_DISCOVERY_DATA_DIR"] = join(tmpdir(), "does-not-exist-boundary-audit");
  try {
    const report = await loadRecentBoundaryDiscoveryTimelines();
    assert.deepEqual(report, { available: false, timelines: [] });
  } finally {
    if (originalDirectory === undefined) delete process.env["BOUNDARY_DISCOVERY_DATA_DIR"];
    else process.env["BOUNDARY_DISCOVERY_DATA_DIR"] = originalDirectory;
  }
});