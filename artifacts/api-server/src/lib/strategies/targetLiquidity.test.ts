/**
 * Unit tests for the target-liquidity observability module (task: show
 * whether a 50¢ target missed because of queue depth or an execution problem).
 *
 * Run (esbuild bundle + node --test, same pattern as other api-server tests):
 *   cd artifacts/api-server && node_modules/.bin/esbuild src/lib/strategies/targetLiquidity.test.ts \
 *     --bundle --platform=node --format=esm --outfile=/tmp/tliq.mjs && node --test /tmp/tliq.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractBidDepthAtOrAboveTarget,
  createTargetLiquidityObserver,
  classifyTargetLiquidity,
  buildTargetLiquidityReport,
  type TargetLiquiditySnapshotParams,
  type TargetLiquiditySnapshotView,
  type TargetLiquidityOrderView,
} from "./targetLiquidity.js";

function snap(over: Partial<TargetLiquiditySnapshotView> = {}): TargetLiquiditySnapshotView {
  return {
    contractsAtOrAboveTarget: 0, restingContracts: 10, capturedAtMs: 1000,
    bookError: null, orderStatus: "resting", targetKalshiOrderId: "koid-1",
    targetPlacedAtMs: 500, ...over,
  };
}

function positionInput(over: Record<string, unknown> = {}) {
  return {
    ticker: "KXETH-T1", easternDate: "2026-08-17", side: "yes" as const,
    entryContracts: 10, exitContracts: 0, openContracts: 10, settled: false,
    firstExecutableAtMs: null, snapshots: [] as TargetLiquiditySnapshotView[],
    ...over,
  };
}

describe("targetLiquidity", () => {

  describe("extractBidDepthAtOrAboveTarget", () => {
    it("held YES: keeps yes-side buy levels at/above target, sorted best-first", () => {
      const raw = { orderbook_fp: { yes_dollars: [["0.49", "5"], ["0.50", "7"], ["0.52", "3"]], no_dollars: [["0.40", "99"]] } };
      const { levels, contracts } = extractBidDepthAtOrAboveTarget(raw as never, "yes", 50);
      assert.deepEqual(levels, [
        { priceCents: 52, contractsApprox: 3 },
        { priceCents: 50, contractsApprox: 7 },
      ]);
      assert.equal(contracts, 10);
    });

    it("held NO: uses no-side buyers and ignores yes levels", () => {
      const raw = { orderbook_fp: { yes_dollars: [["0.60", "50"]], no_dollars: [["0.50", "4"], ["0.31", "9"]] } };
      const { levels, contracts } = extractBidDepthAtOrAboveTarget(raw as never, "no", 50);
      assert.deepEqual(levels, [{ priceCents: 50, contractsApprox: 4 }]);
      assert.equal(contracts, 4);
    });

    it("empty book yields zero depth", () => {
      const { levels, contracts } = extractBidDepthAtOrAboveTarget({} as never, "yes", 50);
      assert.deepEqual(levels, []);
      assert.equal(contracts, 0);
    });
  });

  describe("createTargetLiquidityObserver", () => {
    function makeDeps(over: Record<string, unknown> = {}) {
      const inserted: TargetLiquiditySnapshotParams[] = [];
      let nowMs = 100_000;
      const orders: TargetLiquidityOrderView[] = [{
        id: "exit:KXETH-T1:1", role: "exit", outcome: "pending", kalshiOrderId: "koid-1",
        requestedContracts: 10, filledContracts: 0, createdAtMs: 90_000,
      }];
      const deps = {
        strategy: "ETH_30_50", targetCents: 50, intervalMs: 30_000,
        listOrders: async () => orders,
        fetchOrderbookRaw: async () => ({ orderbook_fp: { yes_dollars: [["0.50", "12"]], no_dollars: [] } }),
        fetchOrderStatus: async () => "resting",
        insertSnapshot: (p: TargetLiquiditySnapshotParams) => { inserted.push(p); },
        easternDate: () => "2026-08-17",
        now: () => nowMs,
        ...over,
      };
      return { deps, inserted, orders, setNow: (v: number) => { nowMs = v; } };
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it("captures a snapshot when armed and held-side bid >= target", async () => {
      const { deps, inserted } = makeDeps();
      const obs = createTargetLiquidityObserver(deps as never);
      obs.arm("KXETH-T1", "yes");
      obs.observe("KXETH-T1", { yesBid: 51, noBid: 20 });
      await tick(); await tick();
      assert.equal(inserted.length, 1);
      const s = inserted[0]!;
      assert.equal(s.strategy, "ETH_30_50");
      assert.equal(s.targetKalshiOrderId, "koid-1");
      assert.equal(s.targetOrderDbId, "exit:KXETH-T1:1");
      assert.equal(s.targetPlacedAtMs, 90_000);
      assert.equal(s.orderStatus, "resting");
      assert.equal(s.restingContracts, 10);
      assert.equal(s.observedBidCents, 51);
      assert.equal(s.contractsAtOrAboveTarget, 12);
      assert.deepEqual(s.bidLevelsAtOrAboveTarget, [{ priceCents: 50, contractsApprox: 12 }]);
      assert.equal(s.bookError, null);
    });

    it("does not capture when not armed, bid below target, or wrong side's bid high", async () => {
      const { deps, inserted } = makeDeps();
      const obs = createTargetLiquidityObserver(deps as never);
      obs.observe("KXETH-T1", { yesBid: 55 });               // not armed
      obs.arm("KXETH-T1", "yes");
      obs.observe("KXETH-T1", { yesBid: 49 });               // below target
      obs.observe("KXETH-T1", { yesBid: null, noBid: 60 });  // held side has no bid
      await tick(); await tick();
      assert.equal(inserted.length, 0);
    });

    it("throttles: second observe inside interval is dropped, after interval fires", async () => {
      const { deps, inserted, setNow } = makeDeps();
      const obs = createTargetLiquidityObserver(deps as never);
      obs.arm("KXETH-T1", "yes");
      obs.observe("KXETH-T1", { yesBid: 51 });
      await tick(); await tick();
      obs.observe("KXETH-T1", { yesBid: 52 });               // +0ms — throttled
      await tick(); await tick();
      assert.equal(inserted.length, 1);
      setNow(100_000 + 30_001);
      obs.observe("KXETH-T1", { yesBid: 52 });
      await tick(); await tick();
      assert.equal(inserted.length, 2);
    });

    it("self-disarms when durable rows show no resting exit", async () => {
      const { deps, inserted, orders } = makeDeps();
      orders[0]!.outcome = "full_fill";
      const obs = createTargetLiquidityObserver(deps as never);
      obs.arm("KXETH-T1", "yes");
      obs.observe("KXETH-T1", { yesBid: 51 });
      await tick(); await tick();
      assert.equal(inserted.length, 0);
      assert.equal(obs.isArmed("KXETH-T1"), false);
    });

    it("records bookError and empty depth when the orderbook fetch fails; status failure yields null", async () => {
      const { deps, inserted } = makeDeps({
        fetchOrderbookRaw: async () => { throw new Error("book boom"); },
        fetchOrderStatus: async () => { throw new Error("status boom"); },
      });
      const obs = createTargetLiquidityObserver(deps as never);
      obs.arm("KXETH-T1", "yes");
      obs.observe("KXETH-T1", { yesBid: 51 });
      await tick(); await tick();
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0]!.bookError, "book boom");
      assert.equal(inserted[0]!.contractsAtOrAboveTarget, 0);
      assert.equal(inserted[0]!.orderStatus, null);
    });

    it("disarm stops observation", async () => {
      const { deps, inserted } = makeDeps();
      const obs = createTargetLiquidityObserver(deps as never);
      obs.arm("KXETH-T1", "yes");
      obs.disarm("KXETH-T1");
      obs.observe("KXETH-T1", { yesBid: 55 });
      await tick(); await tick();
      assert.equal(inserted.length, 0);
    });

    it("insert failure never throws out of observe", async () => {
      const { deps } = makeDeps({ insertSnapshot: () => { throw new Error("db down"); } });
      const obs = createTargetLiquidityObserver(deps as never);
      obs.arm("KXETH-T1", "yes");
      assert.doesNotThrow(() => obs.observe("KXETH-T1", { yesBid: 51 }));
      await tick(); await tick();
    });
  });

  describe("classifyTargetLiquidity", () => {
    it("no_position when nothing was ever filled", () => {
      const r = classifyTargetLiquidity(positionInput({ entryContracts: 0, openContracts: 0 }));
      assert.equal(r.classification, "no_position");
    });

    it("target_filled when exit fills cover the entry", () => {
      const r = classifyTargetLiquidity(positionInput({ exitContracts: 10, openContracts: 0 }));
      assert.equal(r.classification, "target_filled");
    });

    it("never_reached_target without first-executable evidence or snapshots", () => {
      const r = classifyTargetLiquidity(positionInput());
      assert.equal(r.classification, "never_reached_target");
    });

    it("reached_target_no_depth_data when reached but only errored snapshots (or none)", () => {
      const a = classifyTargetLiquidity(positionInput({ firstExecutableAtMs: 123 }));
      assert.equal(a.classification, "reached_target_no_depth_data");
      const b = classifyTargetLiquidity(positionInput({ snapshots: [snap({ bookError: "boom" })] }));
      assert.equal(b.classification, "reached_target_no_depth_data");
    });

    it("insufficient_depth when every usable snapshot shows depth < resting size", () => {
      const r = classifyTargetLiquidity(positionInput({
        snapshots: [snap({ contractsAtOrAboveTarget: 3 }), snap({ contractsAtOrAboveTarget: 9, capturedAtMs: 2000 })],
      }));
      assert.equal(r.classification, "insufficient_depth");
      assert.equal(r.maxContractsAtOrAboveTarget, 9);
      assert.equal(r.sufficientDepthSnapshots, 0);
    });

    it("sufficient_depth_unfilled when any usable snapshot covers the resting size", () => {
      const r = classifyTargetLiquidity(positionInput({
        snapshots: [snap({ contractsAtOrAboveTarget: 3 }), snap({ contractsAtOrAboveTarget: 10, capturedAtMs: 2000 })],
      }));
      assert.equal(r.classification, "sufficient_depth_unfilled");
      assert.equal(r.sufficientDepthSnapshots, 1);
      assert.equal(r.firstSnapshotAtMs, 1000);
      assert.equal(r.lastSnapshotAtMs, 2000);
      assert.equal(r.lastOrderStatus, "resting");
      assert.equal(r.targetKalshiOrderId, "koid-1");
      assert.equal(r.targetPlacedAtMs, 500);
    });

    it("partial exit fill still classifies on snapshots (not target_filled)", () => {
      const r = classifyTargetLiquidity(positionInput({
        exitContracts: 4, openContracts: 6,
        snapshots: [snap({ contractsAtOrAboveTarget: 2, restingContracts: 6 })],
      }));
      assert.equal(r.classification, "insufficient_depth");
    });
  });

  describe("buildTargetLiquidityReport", () => {
    it("aggregates positions and summary counts, dropping no_position rows", () => {
      const report = buildTargetLiquidityReport("ETH_30_50", 50, [
        positionInput({ ticker: "A", exitContracts: 10, openContracts: 0 }),
        positionInput({ ticker: "B" }),
        positionInput({ ticker: "C", snapshots: [snap({ contractsAtOrAboveTarget: 99 })] }),
        positionInput({ ticker: "D", snapshots: [snap({ contractsAtOrAboveTarget: 1 })] }),
        positionInput({ ticker: "E", entryContracts: 0, openContracts: 0 }),
      ], 7777);
      assert.equal(report.strategy, "ETH_30_50");
      assert.equal(report.targetCents, 50);
      assert.equal(report.generatedAtMs, 7777);
      assert.equal(report.positions.length, 4);
      assert.deepEqual(report.summary, {
        positions: 4, targetFilled: 1, neverReachedTarget: 1,
        reachedNoDepthData: 0, insufficientDepth: 1, sufficientDepthUnfilled: 1,
      });
    });
  });
});
