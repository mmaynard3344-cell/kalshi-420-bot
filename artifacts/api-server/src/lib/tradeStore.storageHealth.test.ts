import assert from "node:assert/strict";
import test from "node:test";
import { deriveEvidenceStorageOutcome, type EvidenceStorageTableHealth } from "./tradeStore.js";

const ok = (table: string): EvidenceStorageTableHealth => ({
  table, source: "sql_authoritative", state: "ok", rowCount: 1, retainedBytes: 10,
  firstRecordedAt: null, lastRecordedAt: null, queryLatencyMs: 1,
});
const unavailable = (table: string): EvidenceStorageTableHealth => ({
  ...ok(table), state: "unavailable", rowCount: null, retainedBytes: null,
});

test("storage health warns when any SQL evidence table is unavailable", () => {
  const result = deriveEvidenceStorageOutcome([ok("window_ticks"), unavailable("preflight_decisions")], 1, 8, 2);
  assert.equal(result.source, "environment_local_fallback");
  assert.deepEqual(result.warnings, ["sql_unavailable", "environment_local_fallback"]);
});

test("storage health never presents total SQL failure as authoritative", () => {
  const result = deriveEvidenceStorageOutcome([unavailable("window_ticks"), unavailable("preflight_decisions")], 0, 0, 2);
  assert.equal(result.source, "environment_local_fallback");
  assert.deepEqual(result.warnings, ["sql_unavailable", "environment_local_fallback"]);
});