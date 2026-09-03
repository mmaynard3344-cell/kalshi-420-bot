import assert from "node:assert/strict";
import test from "node:test";
import { getResearchRetentionStatus } from "./researchRetentionStatus.js";

test("research retention status keeps raw capture disabled by default", () => {
  const before = process.env.LEGACY_RAW_RESEARCH_CAPTURE_ENABLED;
  delete process.env.LEGACY_RAW_RESEARCH_CAPTURE_ENABLED;
  try {
    const status = getResearchRetentionStatus();
    assert.equal(status.rawResearchRetention, "disabled_by_default");
    assert.equal(status.rawTickPersistence, false);
    assert.equal(status.executionGate, false);
    assert.equal(status.compactDerivedCollectors.btcEth.includes("btc-eth"), true);
  } finally {
    if (before === undefined) delete process.env.LEGACY_RAW_RESEARCH_CAPTURE_ENABLED;
    else process.env.LEGACY_RAW_RESEARCH_CAPTURE_ENABLED = before;
  }
});