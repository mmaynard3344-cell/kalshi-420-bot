import assert from "node:assert/strict";
import test from "node:test";
import {
  _setSweepReclaimAdmissionDepsForTesting,
  admitSweepReclaimBeforeSubmit,
} from "./sweepReclaimLiveAdmission.js";
import type {
  EthLongReversalReservation,
  EthLongReversalStore,
} from "./ethLongReversalExposure.js";
import type { SweepReclaimRuntimeConfig } from "./sweepReclaimV1.js";

function config(overrides: Partial<SweepReclaimRuntimeConfig> = {}): SweepReclaimRuntimeConfig {
  return {
    enabled: true,
    maxEntryPriceCents: 50,
    stakeCents: 1000,
    sharedCorrelatedExposureCapCents: 200,
    minimumSecondsRemaining: 1,
    orderType: "test",
    activationReady: true,
    unresolved: [],
    ...overrides,
  };
}

function memoryStore(seed: EthLongReversalReservation[] = []): EthLongReversalStore {
  const rows = new Map(seed.map((r) => [r.id, r]));
  return {
    withAdmissionLock: async (fn) => fn({
      sumActiveRiskCents: async () => [...rows.values()]
        .filter((r) => ["reserved","submitted","submission_unknown","filled_unsettled"].includes(r.state))
        .reduce((sum, r) => sum + r.requestedRiskCents, 0),
      insertReservation: async (r) => {
        if (rows.has(r.id) || [...rows.values()].some((x) => x.clientOrderId === r.clientOrderId)) return false;
        rows.set(r.id, r);
        return true;
      },
    }),
    transition: async ({ id, from, to, updatedAtMs }) => {
      const row = rows.get(id);
      const allowed = Array.isArray(from) ? from : [from];
      if (!row || !allowed.includes(row.state)) return false;
      rows.set(id, { ...row, state: to, updatedAtMs });
      return true;
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    claimId: "claim-l-1",
    destinationTicker: "KXETH15M-TEST-L",
    exchangeIndex: 1,
    clientOrderId: "client-l-1",
    requestedContracts: 2,
    requestedRiskCents: 80,
    finalYesPriceCents: 40,
    config: config(),
    ...overrides,
  } as any;
}

test("disabled or unresolved config cannot admit L", async () => {
  _setSweepReclaimAdmissionDepsForTesting({
    store: memoryStore(),
    claimUpdater: async () => true,
  });
  assert.equal((await admitSweepReclaimBeforeSubmit(input({ config: config({ enabled: false }) }))).outcome, "disabled");
  assert.equal((await admitSweepReclaimBeforeSubmit(input({
    config: config({ activationReady: false, maxEntryPriceCents: null, unresolved: ["max_entry_price_cents"] }),
  }))).outcome, "config_unresolved");
});

test("final price above hard cap blocks before correlated reservation", async () => {
  let updates = 0;
  _setSweepReclaimAdmissionDepsForTesting({
    store: memoryStore(),
    claimUpdater: async () => { updates++; return true; },
  });
  const result = await admitSweepReclaimBeforeSubmit(input({ finalYesPriceCents: 51 }));
  assert.equal(result.outcome, "price_cap_blocked");
  assert.equal(updates, 1);
});

test("existing E/H/I long-reversal exposure blocks L over shared cap", async () => {
  const store = memoryStore([{
    id:"e-existing",bucket:"ETH_15M_LONG_REVERSAL",service:"E",strategy:"downfade",
    ticker:"KXETH15M-OLD",clientOrderId:"cid-e",sourceOrderId:"e-order",exchangeIndex:1,
    requestedRiskCents:150,state:"submitted",createdAtMs:1,updatedAtMs:1,
  }]);
  _setSweepReclaimAdmissionDepsForTesting({ store, claimUpdater: async () => true });
  const result = await admitSweepReclaimBeforeSubmit(input({ requestedRiskCents: 60 }));
  assert.equal(result.outcome, "correlated_cap_blocked");
});

test("L admitted only after durable pending write and shared reservation", async () => {
  const states: string[] = [];
  _setSweepReclaimAdmissionDepsForTesting({
    store: memoryStore(),
    claimUpdater: async (u) => { states.push(String(u.lifecycleState)); return true; },
  });
  const result = await admitSweepReclaimBeforeSubmit(input());
  assert.equal(result.outcome, "admitted");
  assert.ok(result.reservationId);
  assert.deepEqual(states, ["ADMISSION_PENDING","ADMITTED"]);
});

test("failed durable ADMITTED write releases temporary shared reservation", async () => {
  const store = memoryStore();
  let calls = 0;
  _setSweepReclaimAdmissionDepsForTesting({
    store,
    claimUpdater: async () => (++calls) === 1,
  });
  const result = await admitSweepReclaimBeforeSubmit(input());
  assert.equal(result.outcome, "persistence_failed");
});
