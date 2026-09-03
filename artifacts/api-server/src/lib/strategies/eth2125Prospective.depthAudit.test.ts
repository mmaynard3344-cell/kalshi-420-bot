/**
 * Depth-audit tests for the ETH 21–25¢ → 50¢ prospective cohort: a recorded
 * 50¢ reach must be classified against retained post-entry depth snapshots
 * and the hypothetical $10 position size, never trusted as a bare BBO touch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditEth2125TargetDepth, eth2125Contracts, eth2125DepthRetentionActive,
  ETH2125_DEPTH_STRATEGY, ETH2125_TARGET_CENTS,
  ETH2125_DEPTH_RETENTION_GRACE_MS, ETH2125_REVIEW_TRADES,
} from "./eth2125Prospective.js";
import { extractBidDepthAtOrAboveTarget } from "./targetLiquidity.js";

describe("eth2125 depth audit", () => {
  it("classifies an unreached target as not_reached regardless of snapshots", () => {
    const audit = auditEth2125TargetDepth(null, 40, [
      { contractsAtOrAboveTarget: 100, bookError: null },
    ]);
    assert.equal(audit.classification, "not_reached");
    assert.equal(audit.depthConfirmed, false);
  });

  it("classifies a reach with no usable snapshots as bbo_touch_only", () => {
    assert.equal(auditEth2125TargetDepth(1, 40, []).classification, "bbo_touch_only");
    // Snapshots with book errors carry no usable depth.
    const audit = auditEth2125TargetDepth(1, 40, [
      { contractsAtOrAboveTarget: 0, bookError: "fetch failed" },
    ]);
    assert.equal(audit.classification, "bbo_touch_only");
    assert.equal(audit.snapshotCount, 1);
    assert.equal(audit.usableSnapshotCount, 0);
    assert.equal(audit.maxContractsAtOrAboveTarget, null);
  });

  it("classifies usable depth below the hypothetical size as insufficient_depth", () => {
    const audit = auditEth2125TargetDepth(1, 40, [
      { contractsAtOrAboveTarget: 39, bookError: null },
      { contractsAtOrAboveTarget: 10, bookError: null },
    ]);
    assert.equal(audit.classification, "insufficient_depth");
    assert.equal(audit.maxContractsAtOrAboveTarget, 39);
    assert.equal(audit.depthConfirmed, false);
  });

  it("confirms depth when any usable snapshot covers the full size", () => {
    const audit = auditEth2125TargetDepth(1, 40, [
      { contractsAtOrAboveTarget: 5, bookError: null },
      { contractsAtOrAboveTarget: 40, bookError: null },
      { contractsAtOrAboveTarget: 0, bookError: "later fetch failed" },
    ]);
    assert.equal(audit.classification, "depth_confirmed");
    assert.equal(audit.depthConfirmed, true);
    assert.equal(audit.usableSnapshotCount, 2);
  });

  it("audits against the $10 floor-sized contract count", () => {
    // 21¢ entry → floor(1000/21) = 47 contracts (depth permitting).
    const contracts = eth2125Contracts(21, 1_000);
    assert.equal(contracts, 47);
    assert.equal(auditEth2125TargetDepth(1, contracts,
      [{ contractsAtOrAboveTarget: 46, bookError: null }]).classification, "insufficient_depth");
    assert.equal(auditEth2125TargetDepth(1, contracts,
      [{ contractsAtOrAboveTarget: 47, bookError: null }]).classification, "depth_confirmed");
  });

  it("uses a distinct snapshot strategy key from the live ETH_30_50 observer", () => {
    assert.equal(ETH2125_DEPTH_STRATEGY, "ETH2125_PROSPECTIVE");
    assert.notEqual(ETH2125_DEPTH_STRATEGY, "ETH_30_50");
  });

  it("retention policy: exempt while accumulating, bounded grace after the gate", () => {
    const now = 1_800_000_000_000;
    // Below the review gate: always retain (including the fail-safe empty read).
    assert.equal(eth2125DepthRetentionActive(0, null, now), true);
    assert.equal(eth2125DepthRetentionActive(ETH2125_REVIEW_TRADES - 1, null, now), true);
    // At/after the gate: retain only within the grace window of the gate row.
    assert.equal(eth2125DepthRetentionActive(ETH2125_REVIEW_TRADES, now - 1_000, now), true);
    assert.equal(eth2125DepthRetentionActive(
      ETH2125_REVIEW_TRADES, now - ETH2125_DEPTH_RETENTION_GRACE_MS + 1, now), true);
    assert.equal(eth2125DepthRetentionActive(
      ETH2125_REVIEW_TRADES, now - ETH2125_DEPTH_RETENTION_GRACE_MS, now), false);
    assert.equal(eth2125DepthRetentionActive(ETH2125_REVIEW_TRADES + 5, null, now), false);
  });

  it("depth extraction counts only levels at/above the 50¢ target", () => {
    const raw = { yes: [
      { price: 49, quantity: 500 }, { price: 50, quantity: 30 }, { price: 55, quantity: 12 },
    ] };
    const depth = extractBidDepthAtOrAboveTarget(raw, "yes", ETH2125_TARGET_CENTS);
    assert.equal(depth.contracts, 42);
    assert.deepEqual(depth.levels.map((l) => l.priceCents), [55, 50]);
  });
});
