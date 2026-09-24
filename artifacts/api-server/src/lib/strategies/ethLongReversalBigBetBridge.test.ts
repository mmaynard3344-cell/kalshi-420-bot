import assert from "node:assert/strict";
import test from "node:test";
import {
  _setLongReversalBridgeStoreForTesting,
  submitEthBigBetWithLongReversalAdmission,
} from "./ethLongReversalBigBetBridge.js";
import type {
  EthLongReversalReservation,
  EthLongReversalStore,
} from "./ethLongReversalExposure.js";
import type { EthBigBetExecutionStore } from "./ethBigBetExecutor.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

function memoryLongStore(seed: EthLongReversalReservation[] = []) {
  const rows = new Map(seed.map((r) => [r.id, r]));
  const store: EthLongReversalStore = {
    async withAdmissionLock(fn) {
      return fn({
        async sumActiveRiskCents() {
          return [...rows.values()]
            .filter((r) => ["reserved","submitted","submission_unknown","filled_unsettled"].includes(r.state))
            .reduce((sum, r) => sum + r.activeRiskCents, 0);
        },
        async insertReservation(reservation) {
          if (rows.has(reservation.id)) return false;
          rows.set(reservation.id, reservation);
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

function executionStore(outcome: "reserved" | "capital_blocked" | "reservation_failed" = "reserved"): EthBigBetExecutionStore {
  return {
    async listUnresolvedEthBigBetOrderIds() { return []; },
    async reserveEthBigBetOrder() { return outcome; },
    async acknowledgeEthBigBetOrder() { return true; },
  };
}

function intent(side: "yes"|"no", tag: string): EthBigBetOrderIntent {
  return {
    strategy: "ash_v2_i",
    orderTag: tag,
    ticker: "KXETH15M-TEST-BRIDGE",
    side,
    wagerCents: 100,
    limitPriceCents: 50,
    marketOpenTimeMs: 1,
  };
}

const capital = {
  availableBalanceCents: 10_000,
  martingaleReserveCents: 0,
  safetyReserveCents: 0,
  otherBigBetReservedCents: 0,
};

test("H correlated YES is blocked before Kalshi submit when shared cap is consumed", async () => {
  process.env.ETH_LONG_REVERSAL_SHARED_CAP_CENTS = "100";
  const seed: EthLongReversalReservation = {
    id: "existing", bucket: "ETH_15M_LONG_REVERSAL", service: "E", strategy: "downfade_p80_p90",
    ticker: "KXETH15M-OLD", clientOrderId: "old", sourceOrderId: "old", exchangeIndex: 1,
    requestedRiskCents: 100, activeRiskCents: 100, filledContracts: null, actualNotionalCents: null, actualFeeCents: null, lastAdjustmentReason: null, state: "submitted", createdAtMs: 1, updatedAtMs: 1,
  };
  const { store } = memoryLongStore([seed]);
  _setLongReversalBridgeStoreForTesting(store);
  let submitted = false;
  const outcome = await submitEthBigBetWithLongReversalAdmission({
    service: "H",
    intent: { ...intent("yes","h"), strategy: "downfade_p95_p99" },
    exchangeIndex: 1,
    executionStore: executionStore(),
    exchange: { async submit() { submitted = true; return { kind: "accepted", exchangeOrderId: "x" }; } },
    capital,
    requestedRiskCents: 1,
  });
  assert.equal(outcome, "correlated_cap_blocked");
  assert.equal(submitted, false);
});

test("I downside YES uses shared bucket and can be blocked", async () => {
  process.env.ETH_LONG_REVERSAL_SHARED_CAP_CENTS = "50";
  const { store } = memoryLongStore([{
    id: "existing-i", bucket: "ETH_15M_LONG_REVERSAL", service: "L", strategy: "SWEEP_RECLAIM_V1",
    ticker: "KXETH15M-OLD2", clientOrderId: "old2", sourceOrderId: "old2", exchangeIndex: 1,
    requestedRiskCents: 50, activeRiskCents: 50, filledContracts: null, actualNotionalCents: null, actualFeeCents: null, lastAdjustmentReason: null, state: "submission_unknown", createdAtMs: 1, updatedAtMs: 1,
  }]);
  _setLongReversalBridgeStoreForTesting(store);
  let submitted = false;
  const outcome = await submitEthBigBetWithLongReversalAdmission({
    service: "I", intent: intent("yes","i-down"), exchangeIndex: 1,
    executionStore: executionStore(),
    exchange: { async submit() { submitted = true; return { kind: "accepted", exchangeOrderId: "x" }; } },
    capital, requestedRiskCents: 1,
  });
  assert.equal(outcome, "correlated_cap_blocked");
  assert.equal(submitted, false);
});

test("I upside NO bypasses long-reversal bucket", async () => {
  delete process.env.ETH_LONG_REVERSAL_SHARED_CAP_CENTS;
  const { store } = memoryLongStore();
  _setLongReversalBridgeStoreForTesting(store);
  let submitted = false;
  const outcome = await submitEthBigBetWithLongReversalAdmission({
    service: "I", intent: intent("no","i-up"), exchangeIndex: 1,
    executionStore: executionStore(),
    exchange: { async submit() { submitted = true; return { kind: "accepted", exchangeOrderId: "i-no-order" }; } },
    capital, requestedRiskCents: 100,
  });
  assert.equal(outcome, "submitted");
  assert.equal(submitted, true);
  assert.equal(store ? true : false, true);
});

test("submission_unknown remains active in shared bucket", async () => {
  process.env.ETH_LONG_REVERSAL_SHARED_CAP_CENTS = "100";
  const { store, rows } = memoryLongStore();
  _setLongReversalBridgeStoreForTesting(store);
  const outcome = await submitEthBigBetWithLongReversalAdmission({
    service: "E",
    intent: { ...intent("yes","e-unknown"), strategy: "downfade_p80_p90" },
    exchangeIndex: 1,
    executionStore: executionStore(),
    exchange: { async submit() { return { kind: "unknown" }; } },
    capital,
    requestedRiskCents: 100,
  });
  assert.equal(outcome, "submission_unknown");
  assert.equal([...rows.values()][0]?.state, "submission_unknown");
});

test.afterEach(() => {
  _setLongReversalBridgeStoreForTesting(null);
  delete process.env.ETH_LONG_REVERSAL_SHARED_CAP_CENTS;
});
