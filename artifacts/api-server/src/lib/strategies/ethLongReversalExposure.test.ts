import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireEthLongReversalExposure,
  isEthLongReversalExposure,
  readEthLongReversalCapCents,
  type EthLongReversalReservation,
  type EthLongReversalStore,
} from "./ethLongReversalExposure.js";

function memoryStore(): EthLongReversalStore {
  const rows = new Map<string, EthLongReversalReservation>();
  let chain = Promise.resolve();
  return {
    withAdmissionLock: async (fn) => {
      let release!: () => void;
      const prior = chain;
      chain = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        return await fn({
          sumActiveRiskCents: async () => [...rows.values()]
            .filter((r) => ["reserved","submitted","submission_unknown","filled_unsettled"].includes(r.state))
            .reduce((sum, r) => sum + r.activeRiskCents, 0),
          insertReservation: async (reservation) => {
            if (rows.has(reservation.id) || [...rows.values()].some((r) => r.clientOrderId === reservation.clientOrderId)) return false;
            rows.set(reservation.id, reservation);
            return true;
          },
        });
      } finally { release(); }
    },
    transition: async ({ id, from, to, updatedAtMs }) => {
      const row = rows.get(id);
      const allowed = Array.isArray(from) ? from : [from];
      if (!row || !allowed.includes(row.state)) return false;
      rows.set(id, { ...row, state: to, updatedAtMs });
      return true;
    },
  };
}

function input(store: EthLongReversalStore, id: string, service: "E"|"H"|"I"|"L", side: "yes"|"no", risk: number, cap = 200) {
  return {
    id, service, strategy: "test", ticker: "KXETH15M-TEST", side,
    clientOrderId: "cid-"+id, exchangeIndex: 1, requestedRiskCents: risk,
    capCents: cap, store, nowMs: 1,
  };
}

test("membership includes E/H/L YES and only the downside YES branch of I", () => {
  assert.equal(isEthLongReversalExposure("E","yes"), true);
  assert.equal(isEthLongReversalExposure("H","yes"), true);
  assert.equal(isEthLongReversalExposure("L","yes"), true);
  assert.equal(isEthLongReversalExposure("I","yes"), true);
  assert.equal(isEthLongReversalExposure("I","no"), false);
});

test("shared cap is unresolved unless explicitly configured", () => {
  assert.equal(readEthLongReversalCapCents({}), null);
  assert.equal(readEthLongReversalCapCents({ ETH_LONG_REVERSAL_SHARED_CAP_CENTS:"0" }), null);
  assert.equal(readEthLongReversalCapCents({ ETH_LONG_REVERSAL_SHARED_CAP_CENTS:"500" }), 500);
});

test("exactly at cap admits and one cent over blocks", async () => {
  const store=memoryStore();
  assert.equal((await acquireEthLongReversalExposure(input(store,"e","E","yes",100,150))).allowed,true);
  const exact=await acquireEthLongReversalExposure(input(store,"l","L","yes",50,150));
  assert.equal(exact.allowed,true);
  const over=await acquireEthLongReversalExposure(input(store,"h","H","yes",1,150));
  assert.equal(over.allowed,false);
  assert.equal(over.reason,"cap_exceeded");
});

test("I upside NO is not admitted into the long-reversal bucket", async () => {
  const decision=await acquireEthLongReversalExposure(input(memoryStore(),"i-no","I","no",10,100));
  assert.equal(decision.allowed,false);
  assert.equal(decision.reason,"invalid_input");
});

test("submission_unknown remains active exposure until explicit release", async () => {
  const store=memoryStore();
  const first=await acquireEthLongReversalExposure(input(store,"l-unknown","L","yes",90,100));
  assert.equal(first.allowed,true);
  assert.equal(await store.transition({id:"l-unknown",from:"reserved",to:"submission_unknown",updatedAtMs:2}),true);
  const blocked=await acquireEthLongReversalExposure(input(store,"e-blocked","E","yes",11,100));
  assert.equal(blocked.allowed,false);
  assert.equal(blocked.reason,"cap_exceeded");
  assert.equal(await store.transition({id:"l-unknown",from:"submission_unknown",to:"released",updatedAtMs:3}),true);
  const allowed=await acquireEthLongReversalExposure(input(store,"e-allowed","E","yes",11,100));
  assert.equal(allowed.allowed,true);
});

test("concurrent services serialize admission and cannot oversubscribe", async () => {
  const store=memoryStore();
  const [a,b]=await Promise.all([
    acquireEthLongReversalExposure(input(store,"e-race","E","yes",60,100)),
    acquireEthLongReversalExposure(input(store,"h-race","H","yes",60,100)),
  ]);
  assert.equal([a.allowed,b.allowed].filter(Boolean).length,1);
  assert.equal([a,b].some((x)=>!x.allowed&&x.reason==="cap_exceeded"),true);
});
