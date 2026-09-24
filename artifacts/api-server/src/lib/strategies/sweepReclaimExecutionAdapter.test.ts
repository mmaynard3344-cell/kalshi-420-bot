import assert from "node:assert/strict";
import test from "node:test";
import {
  _setSweepReclaimExecutionDepsForTesting,
  buildSweepReclaimOrderSize,
  executeSweepReclaimV1,
} from "./sweepReclaimExecutionAdapter.js";
import {
  _setSweepReclaimAdmissionDepsForTesting,
} from "./sweepReclaimLiveAdmission.js";
import type {
  EthLongReversalReservation,
  EthLongReversalStore,
} from "./ethLongReversalExposure.js";
import type { SweepReclaimLifecycleState } from "../tradeStore.js";
import type { SweepReclaimRuntimeConfig } from "./sweepReclaimV1.js";

function config(overrides: Partial<SweepReclaimRuntimeConfig> = {}): SweepReclaimRuntimeConfig {
  return {
    enabled: true,
    liveExecutionEnabled: true,
    maxEntryPriceCents: 50,
    stakeCents: 1_000,
    sharedCorrelatedExposureCapCents: 5_000,
    minimumSecondsRemaining: 30,
    orderType: "good_till_canceled",
    activationReady: true,
    unresolved: [],
    ...overrides,
  };
}

function snapshot(price: number | null, error: string | null = null) {
  return {
    ticker: "KXETH15M-TEST-L",
    capturedAtMs: 1,
    side: "yes" as const,
    limitCents: 50,
    rawEntryCount: price == null ? 0 : 1,
    totalLevels: price == null ? 0 : 1,
    lowestLevelCents: price,
    lowestLevelDollars: price == null ? null : 10,
    lowestLevelContractsApprox: price == null ? null : 10,
    highestLevelCents: price,
    highestLevelDollars: price == null ? null : 10,
    nearLimitLevels: [],
    depthAtOrBetterDollars: price != null && price <= 50 ? 10 : 0,
    depthAtOrBetterContracts: price != null && price <= 50 ? 10 : 0,
    fetchLatencyMs: 1,
    error,
    rawYesDollars: [],
    rawNoDollars: [],
  };
}

function memoryLongStore() {
  const rows = new Map<string, EthLongReversalReservation>();
  const store: EthLongReversalStore = {
    async withAdmissionLock(fn) {
      return fn({
        async sumActiveRiskCents() {
          return [...rows.values()]
            .filter((r) => ["reserved","submitted","submission_unknown","filled_unsettled"].includes(r.state))
            .reduce((sum, r) => sum + r.activeRiskCents, 0);
        },
        async insertReservation(r) {
          if (rows.has(r.id)) return false;
          rows.set(r.id, r);
          return true;
        },
      });
    },
    async transition({ id, from, to, updatedAtMs }) {
      const row = rows.get(id);
      const allowed = Array.isArray(from) ? from : [from];
      if (!row || !allowed.includes(row.state)) return false;
      rows.set(id, { ...row, state: to, updatedAtMs });
      return true;
    },
  };
  return { store, rows };
}

function harness(prices: Array<number | null>) {
  const { store, rows } = memoryLongStore();
  let state: SweepReclaimLifecycleState = "CLAIMED";
  let posts = 0;
  let transitionCalls = 0;

  _setSweepReclaimAdmissionDepsForTesting({
    store,
    claimUpdater: async (u) => {
      if (u.lifecycleState) state = u.lifecycleState;
      return true;
    },
  });
  _setSweepReclaimExecutionDepsForTesting({
    priceReader: async () => snapshot(prices.shift() ?? null),
    exchange: {
      async submit() {
        posts++;
        return { kind: "accepted", exchangeOrderId: "kalshi-l-1" };
      },
    },
    claimUpdater: async (u) => {
      if (u.lifecycleState) state = u.lifecycleState;
      return true;
    },
    claimTransition: async ({ from, to }) => {
      transitionCalls++;
      const allowed = Array.isArray(from) ? from : [from];
      if (!allowed.includes(state)) return false;
      state = to;
      return true;
    },
  });

  return {
    rows,
    get state() { return state; },
    get posts() { return posts; },
    get transitionCalls() { return transitionCalls; },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    claimId: "claim-l-live-1",
    destinationTicker: "KXETH15M-TEST-L",
    exchangeIndex: 1,
    destinationCloseTimeMs: 1_000_000,
    clientOrderId: "l-sweep-reclaim-client-1",
    config: config(),
    nowMs: 100_000,
    ...overrides,
  } as any;
}

test("order sizing uses stake as a hard principal budget at the configured cap plus fee headroom", () => {
  const size = buildSweepReclaimOrderSize(config({ stakeCents: 1_000, maxEntryPriceCents: 50 }));
  assert.deepEqual(size, {
    contracts: 20,
    maxPrincipalCents: 1_000,
    feeHeadroomCents: 350,
    requestedRiskCents: 1_350,
  });
});

test("live execution flag defaults to a hard stop with no POST", async () => {
  const h = harness([40, 40]);
  const result = await executeSweepReclaimV1(input({
    config: config({ liveExecutionEnabled: false }),
  }));
  assert.equal(result, "live_execution_disabled");
  assert.equal(h.posts, 0);
});

test("first executable price above hard cap blocks before shared reservation and POST", async () => {
  const h = harness([51]);
  const result = await executeSweepReclaimV1(input());
  assert.equal(result, "price_cap_blocked");
  assert.equal(h.posts, 0);
  assert.equal(h.rows.size, 0);
});

test("second executable price breach releases reservation and never POSTs", async () => {
  const h = harness([40, 51]);
  const result = await executeSweepReclaimV1(input());
  assert.equal(result, "price_cap_blocked");
  assert.equal(h.posts, 0);
  assert.equal([...h.rows.values()][0]?.state, "released");
  assert.equal(h.state, "REJECTED");
});

test("atomic ADMITTED to SUBMITTING fence prevents duplicate POST", async () => {
  const h = harness([40, 40]);
  // Simulate another worker already owning submission after admission completed.
  _setSweepReclaimExecutionDepsForTesting({
    priceReader: async () => snapshot(40),
    exchange: {
      async submit() { throw new Error("must not post"); },
    },
    claimUpdater: async () => true,
    claimTransition: async () => false,
  });
  const result = await executeSweepReclaimV1(input());
  assert.equal(result, "persistence_failed");
  assert.equal(h.posts, 0);
});

test("accepted order becomes SUBMITTED and shared reservation remains active", async () => {
  const h = harness([40, 40]);
  const result = await executeSweepReclaimV1(input());
  assert.equal(result, "submitted");
  assert.equal(h.posts, 1);
  assert.equal(h.state, "SUBMITTED");
  assert.equal([...h.rows.values()][0]?.state, "submitted");
});

test("ambiguous submission retains shared exposure as submission_unknown", async () => {
  const h = harness([40, 40]);
  _setSweepReclaimExecutionDepsForTesting({
    priceReader: async () => snapshot(40),
    exchange: { async submit() { return { kind: "unknown" }; } },
    claimUpdater: async (u) => { if (u.lifecycleState) (h as any)._noop = u.lifecycleState; return true; },
    claimTransition: async ({ from, to }) => {
      const allowed = Array.isArray(from) ? from : [from];
      if (!allowed.includes(h.state)) return false;
      (h as any).state = to;
      return true;
    },
  });
  // Rebuild a clean harness because state accessors are read-only above.
  const m = memoryLongStore();
  let state: SweepReclaimLifecycleState = "CLAIMED";
  _setSweepReclaimAdmissionDepsForTesting({
    store: m.store,
    claimUpdater: async (u) => { if (u.lifecycleState) state = u.lifecycleState; return true; },
  });
  _setSweepReclaimExecutionDepsForTesting({
    priceReader: async () => snapshot(40),
    exchange: { async submit() { return { kind: "unknown" }; } },
    claimUpdater: async (u) => { if (u.lifecycleState) state = u.lifecycleState; return true; },
    claimTransition: async ({ from, to }) => {
      const allowed = Array.isArray(from) ? from : [from];
      if (!allowed.includes(state)) return false;
      state = to;
      return true;
    },
  });
  const result = await executeSweepReclaimV1(input());
  assert.equal(result, "submission_unknown");
  assert.equal(state, "SUBMISSION_UNKNOWN");
  assert.equal([...m.rows.values()][0]?.state, "submission_unknown");
});

test("definitive rejection releases active correlated capacity", async () => {
  const m = memoryLongStore();
  let state: SweepReclaimLifecycleState = "CLAIMED";
  _setSweepReclaimAdmissionDepsForTesting({
    store: m.store,
    claimUpdater: async (u) => { if (u.lifecycleState) state = u.lifecycleState; return true; },
  });
  _setSweepReclaimExecutionDepsForTesting({
    priceReader: async () => snapshot(40),
    exchange: { async submit() { return { kind: "rejected", reason: "exchange_rejected_test" }; } },
    claimUpdater: async (u) => { if (u.lifecycleState) state = u.lifecycleState; return true; },
    claimTransition: async ({ from, to }) => {
      const allowed = Array.isArray(from) ? from : [from];
      if (!allowed.includes(state)) return false;
      state = to;
      return true;
    },
  });
  const result = await executeSweepReclaimV1(input());
  assert.equal(result, "rejected");
  assert.equal(state, "REJECTED");
  assert.equal([...m.rows.values()][0]?.state, "rejected");
});

test.afterEach(() => {
  _setSweepReclaimExecutionDepsForTesting({});
  _setSweepReclaimAdmissionDepsForTesting({});
});
