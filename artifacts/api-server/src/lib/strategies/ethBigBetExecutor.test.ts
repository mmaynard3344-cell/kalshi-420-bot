import assert from "node:assert/strict";
import test from "node:test";
import { buildEthJumpOrderIntent, buildEthReversalOrderIntent } from "./ethBigBetIntent.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetCapitalRiskCents, ethBigBetOrderId, type EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

const capital = {
  availableBalanceCents: 200_000,
  martingaleReserveCents: 43_470,
  safetyReserveCents: 0,
  otherBigBetReservedCents: 0,
};

function executionCapital(intent: EthBigBetOrderIntent) {
  return {
    capital,
    requestedRiskCents: ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents),
  };
}

function memoryStore(unresolved: string[] = [], reservationResult: "reserved" | "capital_blocked" | "reservation_failed" = "reserved") {
  const reservations: string[] = [];
  const acknowledgements: Array<{ orderId: string; status: string }> = [];
  return {
    reservations,
    acknowledgements,
    store: {
      async listUnresolvedEthBigBetOrderIds() { return unresolved; },
      async reserveEthBigBetOrder(input: { orderId: string }) { reservations.push(input.orderId); return reservationResult; },
      async acknowledgeEthBigBetOrder(input: { orderId: string; status: string }) {
        acknowledgements.push({ orderId: input.orderId, status: input.status }); return true;
      },
    },
  };
}

test("Service B carries A's side read-only while owning the $420 wager", () => {
  const yes = buildEthJumpOrderIntent({
    ticker: "KXETH15M-TEST", marketOpenTimeMs: 1_800_000, carriedSide: "yes",
    currentMove: 0.06, p95: 0.05, p99: 0.09,
  });
  const no = buildEthJumpOrderIntent({
    ticker: "KXETH15M-TEST2", marketOpenTimeMs: 2_700_000, carriedSide: "no",
    currentMove: 0.06, p95: 0.05, p99: 0.09,
  });
  assert.equal(yes?.side, "yes");
  assert.equal(no?.side, "no");
  assert.equal(yes?.wagerCents, 42_000);
  assert.equal(no?.wagerCents, 42_000);
});

test("Service C never needs martingale state and always emits a $100 YES intent", () => {
  const intent = buildEthReversalOrderIntent({
    ticker: "KXETH15M-TEST", marketOpenTimeMs: 1_800_000,
    consecutiveNoOutcomes: 3, currentMove: 0.06, p95: 0.05, p99: 0.09,
  });
  assert.equal(intent?.side, "yes");
  assert.equal(intent?.wagerCents, 10_000);
  assert.equal(intent?.strategy, "reversal");
});

test("an unresolved earlier market does not block a new B/C market", async () => {
  const intent: EthBigBetOrderIntent = {
    strategy: "jump", orderTag: "eth-jump-v1", ticker: "KXETH15M-NEW",
    side: "no", wagerCents: 42_000, limitPriceCents: 50, marketOpenTimeMs: 1_800_000,
  };
  const { store, reservations } = memoryStore(["KXETH15M-OLD:eth-jump-v1"]);
  const result = await submitEthBigBetIntent({
    intent, store,
    exchange: { async submit(input) { return { kind: "accepted" as const, exchangeOrderId: `wire:${input.clientOrderId}` }; } },
    ...executionCapital(intent),
    nowMs: 123,
  });
  assert.equal(result, "submitted");
  assert.deepEqual(reservations, [ethBigBetOrderId(intent)]);
});

test("the exact same strategy+market is blocked as a duplicate", async () => {
  const intent: EthBigBetOrderIntent = {
    strategy: "reversal", orderTag: "eth-no3-reversal-v1", ticker: "KXETH15M-SAME",
    side: "yes", wagerCents: 10_000, limitPriceCents: 50, marketOpenTimeMs: 1_800_000,
  };
  const id = ethBigBetOrderId(intent);
  const { store, reservations } = memoryStore([id]);
  const result = await submitEthBigBetIntent({
    intent, store,
    exchange: { async submit() { throw new Error("must not submit"); } },
    ...executionCapital(intent),
  });
  assert.equal(result, "blocked_duplicate");
  assert.deepEqual(reservations, []);
});

test("serialized store capital rejection propagates before exchange POST", async () => {
  const intent: EthBigBetOrderIntent = {
    strategy: "jump", orderTag: "eth-jump-v1", ticker: "KXETH15M-CAPITAL",
    side: "no", wagerCents: 42_000, limitPriceCents: 50, marketOpenTimeMs: 1_800_000,
  };
  const { store } = memoryStore([], "capital_blocked");
  let posted = false;
  const result = await submitEthBigBetIntent({
    intent, store,
    exchange: { async submit() { posted = true; return { kind: "accepted" as const, exchangeOrderId: "bad" }; } },
    ...executionCapital(intent),
  });
  assert.equal(result, "capital_blocked");
  assert.equal(posted, false);
});

test("flat sizing produces 840 jump contracts and 200 reversal contracts at 50 cents", async () => {
  const seen: number[] = [];
  for (const wagerCents of [42_000, 10_000]) {
    const intent: EthBigBetOrderIntent = {
      strategy: wagerCents === 42_000 ? "jump" : "reversal",
      orderTag: wagerCents === 42_000 ? "eth-jump-v1" : "eth-no3-reversal-v1",
      ticker: `KXETH15M-${wagerCents}`, side: "yes", wagerCents,
      limitPriceCents: 50, marketOpenTimeMs: wagerCents,
    };
    const { store } = memoryStore();
    await submitEthBigBetIntent({
      intent, store,
      exchange: { async submit(input) { seen.push(input.contracts); return { kind: "accepted" as const, exchangeOrderId: "ok" }; } },
      ...executionCapital(intent),
    });
  }
  assert.deepEqual(seen, [840, 200]);
});

test("a thrown POST is retained as submission_unknown, never assumed rejected", async () => {
  const intent: EthBigBetOrderIntent = {
    strategy: "jump", orderTag: "eth-jump-v1", ticker: "KXETH15M-UNKNOWN",
    side: "no", wagerCents: 42_000, limitPriceCents: 50, marketOpenTimeMs: 1_800_000,
  };
  const { store, acknowledgements } = memoryStore();
  const result = await submitEthBigBetIntent({
    intent, store,
    exchange: { async submit() { throw new Error("network response lost"); } },
    ...executionCapital(intent),
  });
  assert.equal(result, "submission_unknown");
  assert.deepEqual(acknowledgements, [{ orderId: ethBigBetOrderId(intent), status: "submission_unknown" }]);
});
