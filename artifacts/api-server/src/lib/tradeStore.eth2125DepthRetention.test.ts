/**
 * tradeStore.eth2125DepthRetention.test.ts
 *
 * Integration tests proving the ETH 21–25¢ prospective depth-audit evidence
 * survives the normal target-liquidity snapshot retention/pruning path.
 *
 * Coverage:
 *  1. pruneTargetLiquiditySnapshots deletes expired rows for non-exempt
 *     strategies but preserves expired ETH2125_DEPTH_STRATEGY rows when the
 *     strategy is passed in excludeStrategies (as index.ts does).
 *  2. After that prune, a report-style read (listTargetLiquiditySnapshots with
 *     the cohort-start cutoff) still returns the old snapshot, and the pure
 *     audit still classifies the reach as depth_confirmed — never regressing
 *     to bbo_touch_only.
 *  3. Without the exemption, the same old row would be deleted (guards against
 *     silently dropping the wiring).
 *
 * Isolation: every test runs inside a db.transaction() that is always rolled
 * back via a sentinel throw, so no rows are ever committed.
 * DB-skip guard: the runner script exits 0 when DATABASE_URL is absent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  initTradeStore,
  pruneTargetLiquiditySnapshots,
  listTargetLiquiditySnapshots,
  insertEth2125ProspectiveRow,
  insertTargetLiquiditySnapshot,
} from "./tradeStore.js";
import {
  ETH2125_DEPTH_STRATEGY, ETH2125_COHORT_START_MS, auditEth2125TargetDepth,
  observeEth2125ProspectiveTarget, _resetEth2125DepthStateForTesting,
  ETH2125_DEPTH_SNAPSHOT_INTERVAL_MS,
} from "./strategies/eth2125Prospective.js";
import type { TargetLiquiditySnapshotParams } from "./strategies/targetLiquidity.js";

class RollbackSentinel extends Error {
  constructor() { super("__TEST_ROLLBACK__"); Object.setPrototypeOf(this, RollbackSentinel.prototype); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRolledBackTx(fn: (tx: any) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await initTradeStore(tx as any);
      await fn(tx);
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) throw err;
  }
  await initTradeStore(db);
}

const OLD_DATE    = "2026-06-01"; // well past any 30-day retention window
const RECENT_DATE = "2026-08-16";
const CUTOFF_DATE = "2026-07-18"; // typical "30 days ago" prune cutoff

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any, id: string, strategy: string, ticker: string, easternDate: string,
  contractsAtOrAbove: number, restingContracts: number,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO target_liquidity_snapshots (
      id, strategy, ticker, eastern_date, side,
      target_order_db_id, target_kalshi_order_id, target_placed_at_ms,
      order_status, resting_contracts, observed_bid_cents,
      bid_levels_json, contracts_at_or_above_target, book_error, captured_at_ms
    ) VALUES (
      ${id}, ${strategy}, ${ticker}, ${easternDate}, ${"yes"},
      ${null}, ${null}, ${Date.parse(easternDate + "T12:00:00Z")},
      ${null}, ${restingContracts}, ${52},
      ${JSON.stringify([{ priceCents: 52, contractsApprox: contractsAtOrAbove }])},
      ${contractsAtOrAbove}, ${null}, ${Date.parse(easternDate + "T12:00:00Z")}
    ) ON CONFLICT (id) DO NOTHING
  `);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rowExists(tx: any, id: string): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM target_liquidity_snapshots WHERE id = ${id}
  `);
  return (res.rows?.length ?? 0) > 0;
}

const T = (suffix: string) => `TEST-E2125-RET-${suffix}`;

describe("eth2125 depth-evidence retention through pruning", () => {
  it("preserves expired ETH2125 snapshots while pruning non-exempt strategies", async () => {
    await withRolledBackTx(async (tx) => {
      const exemptOld  = `${ETH2125_DEPTH_STRATEGY}:${T("A")}:old`;
      const otherOld   = `ETH_30_50:${T("B")}:old`;
      const recentRow  = `${ETH2125_DEPTH_STRATEGY}:${T("A")}:recent`;
      await insertSnapshot(tx, exemptOld,  ETH2125_DEPTH_STRATEGY, T("A"), OLD_DATE, 47, 47);
      await insertSnapshot(tx, otherOld,   "ETH_30_50",            T("B"), OLD_DATE, 10, 10);
      await insertSnapshot(tx, recentRow,  ETH2125_DEPTH_STRATEGY, T("A"), RECENT_DATE, 5, 47);

      const pruned = await pruneTargetLiquiditySnapshots(CUTOFF_DATE, [ETH2125_DEPTH_STRATEGY]);
      assert.ok(pruned >= 1, `expected at least the ETH_30_50 fixture pruned, got ${pruned}`);
      assert.equal(await rowExists(tx, exemptOld), true,  "exempt ETH2125 old snapshot must survive the prune");
      assert.equal(await rowExists(tx, otherOld),  false, "non-exempt old snapshot must be pruned");
      assert.equal(await rowExists(tx, recentRow), true,  "recent snapshot always survives");
    });
  });

  it("report read + audit stay depth_confirmed after the normal prune path", async () => {
    await withRolledBackTx(async (tx) => {
      const ticker = T("C");
      // Only depth evidence for this reach is an OLD snapshot that covers the
      // full hypothetical size — exactly the row default retention would kill.
      await insertSnapshot(tx, `${ETH2125_DEPTH_STRATEGY}:${ticker}:old`,
        ETH2125_DEPTH_STRATEGY, ticker, OLD_DATE, 47, 47);

      await pruneTargetLiquiditySnapshots(CUTOFF_DATE, [ETH2125_DEPTH_STRATEGY]);

      // Same read the report performs: explicit cohort-start cutoff.
      const snaps = (await listTargetLiquiditySnapshots(ETH2125_DEPTH_STRATEGY, "2026-01-01"))
        .filter((s) => s.ticker === ticker);
      assert.equal(snaps.length, 1, "old exempt snapshot must remain readable");
      const audit = auditEth2125TargetDepth(Date.parse(OLD_DATE + "T12:00:00Z"), 47, snaps);
      assert.equal(audit.classification, "depth_confirmed");
    });
  });

  it("keeps capturing after a dropped/failed write: a later touch retries and can confirm depth", async () => {
    await withRolledBackTx(async () => {
      _resetEth2125DepthStateForTesting();
      const ticker = T("RETRY");
      const t0 = ETH2125_COHORT_START_MS + 60_000;
      await insertEth2125ProspectiveRow({
        ticker, cohortStartMs: ETH2125_COHORT_START_MS, easternDate: "2026-08-17",
        observedAtMs: t0, side: "yes", entryPriceCents: 21, contracts: 47,
        entryCostCents: 47 * 21, estimatedEntryFeeCents: 55,
        firstTargetAtMs: null, firstTargetBidCents: null,
      });

      let nowMs = t0 + 1_000;
      const inserted: TargetLiquiditySnapshotParams[] = [];
      let fetchCalls = 0;
      let dropWrite = true;
      const deps = {
        fetchOrderbookRaw: async () => {
          fetchCalls++;
          return { yes: [{ price: 52, quantity: 60 }] };
        },
        // First write is "dropped" (fire-and-forget failure); later writes land.
        insertSnapshot: (params: TargetLiquiditySnapshotParams) => {
          if (!dropWrite) inserted.push(params);
        },
        now: () => nowMs,
      };

      await observeEth2125ProspectiveTarget(ticker, nowMs, 52, null, deps);
      assert.equal(fetchCalls, 1, "first touch attempts a capture");
      assert.equal(inserted.length, 0, "first write was dropped");

      // Within the throttle window nothing happens; past it, the observer
      // retries — no permanent suppression after the undurable write.
      await observeEth2125ProspectiveTarget(ticker, nowMs + 1_000, 52, null, deps);
      assert.equal(fetchCalls, 1, "throttled — no capture inside the interval");

      dropWrite = false;
      nowMs += ETH2125_DEPTH_SNAPSHOT_INTERVAL_MS + 1;
      await observeEth2125ProspectiveTarget(ticker, nowMs, 52, null, deps);
      assert.equal(fetchCalls, 2, "later touch retries the capture");
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0]!.contractsAtOrAboveTarget, 60);

      const audit = auditEth2125TargetDepth(t0 + 1_000, 47,
        inserted.map((s) => ({ contractsAtOrAboveTarget: s.contractsAtOrAboveTarget, bookError: s.bookError })));
      assert.equal(audit.classification, "depth_confirmed",
        "evidence becomes depth-confirmed once a later write lands");
      _resetEth2125DepthStateForTesting();
    });
  });

  it("without the exemption the old ETH2125 snapshot would be deleted", async () => {
    await withRolledBackTx(async (tx) => {
      const id = `${ETH2125_DEPTH_STRATEGY}:${T("D")}:old`;
      await insertSnapshot(tx, id, ETH2125_DEPTH_STRATEGY, T("D"), OLD_DATE, 47, 47);
      await pruneTargetLiquiditySnapshots(CUTOFF_DATE); // no excludeStrategies
      assert.equal(await rowExists(tx, id), false,
        "sanity: exemption (not retention accident) is what preserves the evidence");
    });
  });
});

// ── End-to-end: first live 50¢ touch → depth snapshot → depth_confirmed ──────
//
// This test exercises the full production wiring path:
//   observeEth2125ProspectiveTarget
//   → captureEth2125TargetDepth (fetches orderbook via injected dep)
//   → insertTargetLiquiditySnapshot (real fire-and-forget DB write)
//   → listTargetLiquiditySnapshots (reads the committed row back)
//   → auditEth2125TargetDepth (classifies as depth_confirmed)
//
// Unlike the retry/throttle tests above which mock insertSnapshot, this test
// uses the real store function to prove the full round-trip works and that a
// 50¢ touch will never silently produce bbo_touch_only in production.
//
// The test commits to the real DB (fire-and-forget bypasses the rollback
// transaction). It uses a reserved ticker prefix and cleans up before and
// after, so it is safe to re-run.
describe("eth2125 end-to-end: 50¢ touch → real DB snapshot → depth_confirmed", () => {
  const E2E_TICKER = "TEST-E2125-E2E-DEPTH";

  it("observeEth2125ProspectiveTarget wired to real insertTargetLiquiditySnapshot records a usable snapshot", async () => {
    // Pre-clean any leftover rows from a prior interrupted run.
    await db.execute(sql`
      DELETE FROM target_liquidity_snapshots
      WHERE ticker = ${E2E_TICKER} AND strategy = ${ETH2125_DEPTH_STRATEGY}
    `);
    await db.execute(sql`
      DELETE FROM eth2125_prospective_cohort WHERE ticker = ${E2E_TICKER}
    `);

    try {
      await initTradeStore(db);
      _resetEth2125DepthStateForTesting();

      const entryMs = ETH2125_COHORT_START_MS + 120_000;

      // Insert a prospective row (entry recorded, no target touch yet).
      await insertEth2125ProspectiveRow({
        ticker: E2E_TICKER,
        cohortStartMs: ETH2125_COHORT_START_MS,
        easternDate: "2026-08-17",
        observedAtMs: entryMs,
        side: "yes",
        entryPriceCents: 21,
        contracts: 47,
        entryCostCents: 47 * 21,
        estimatedEntryFeeCents: 55,
        firstTargetAtMs: null,
        firstTargetBidCents: null,
      });

      // Simulate the first live 50¢ touch: yesBid=52, mocked orderbook returns
      // 60 contracts of executable depth at 52¢ (covers the hypothetical 47).
      // insertSnapshot uses the real store function — exactly the production wiring
      // in eth30_50.ts: `insertSnapshot: (params) => realStore.insertTargetLiquiditySnapshot(params)`.
      await observeEth2125ProspectiveTarget(
        E2E_TICKER, entryMs + 5_000, /* yesBid */ 52, /* noBid */ null,
        {
          fetchOrderbookRaw: async (_ticker) => ({
            yes: [{ price: 52, quantity: 60 }],
          }),
          insertSnapshot: (params) => insertTargetLiquiditySnapshot(params),
        },
      );

      // insertTargetLiquiditySnapshot is fire-and-forget. Give the async write
      // time to commit before querying.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      // Read back via the same path the report uses.
      const snaps = (
        await listTargetLiquiditySnapshots(ETH2125_DEPTH_STRATEGY, "2026-01-01")
      ).filter((s) => s.ticker === E2E_TICKER);

      assert.equal(snaps.length, 1,
        "one depth snapshot must be committed to target_liquidity_snapshots");
      assert.equal(snaps[0]!.strategy, ETH2125_DEPTH_STRATEGY,
        "snapshot must carry the ETH2125_PROSPECTIVE strategy key");
      assert.equal(snaps[0]!.contractsAtOrAboveTarget, 60,
        "depth from the injected orderbook must be persisted");
      assert.equal(snaps[0]!.bookError, null,
        "a successful fetch must produce no bookError");

      // Full audit: the report will classify this row as depth_confirmed,
      // not bbo_touch_only, proving the capture wiring is end-to-end live.
      const audit = auditEth2125TargetDepth(
        entryMs + 5_000,
        /* hypotheticalContracts */ 47,
        snaps,
      );
      assert.equal(audit.classification, "depth_confirmed",
        "first live 50¢ touch must classify as depth_confirmed, not bbo_touch_only");
      assert.equal(audit.depthConfirmed, true);
    } finally {
      _resetEth2125DepthStateForTesting();
      // Post-test cleanup: remove the committed rows.
      await db.execute(sql`
        DELETE FROM target_liquidity_snapshots
        WHERE ticker = ${E2E_TICKER} AND strategy = ${ETH2125_DEPTH_STRATEGY}
      `);
      await db.execute(sql`
        DELETE FROM eth2125_prospective_cohort WHERE ticker = ${E2E_TICKER}
      `);
    }
  });
});
