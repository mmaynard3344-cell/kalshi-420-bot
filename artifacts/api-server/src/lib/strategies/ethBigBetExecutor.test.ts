import assert from "node:assert/strict";
import test from "node:test";
import { buildEthJumpOrderIntent, buildEthReversalOrderIntent } from "./ethBigBetIntent.js";
import { submitEthBigBetIntent } from "./ethBigBetExecutor.js";
import { ethBigBetOrderId, type EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

function memoryStore(unresolved: string[] = []) {
  const reservations: string[] = [];
  const acknowledgements: Array<{ orderId: string; status: string }> = [];
  return {
    reservations,
    acknowledgements,
    store: {
      async listUnresolvedEthBigBetOrderIds() { return unresolved; },
      async reserveEthBigBetOrder(input: { orderId: string }) { reservations.push(input.orderId); return true; },
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

test("Service C never needs martingale state and always emits a $500 YES intent", () => {
  const intent = buildEthReversalOrderIntent({
    ticker: "KXETH15M-TEST", marketOpenTimeMs: 1_800_000,
    consecutiveNoOutcomes: 3, currentMove: 0.06, p95: 0.05, p99: 0.09,
  });
  assert.equal(intent?.side, "yes");
  assert.equal(intent?.wagerCents, 50_000);
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
    exchange: { async submit(input) { return { exchangeOrderId: `wire:${input.clientOrderId}` }; } },
    nowMs: 123,
  });
  assert.equal(result, "submitted");
  assert.deepEqual(reservations, [ethBigBetOrderId(intent)]);
});

test("the exact same strategy+market is blocked as a duplicate", async () => {
  const intent: EthBigBetOrderIntent = {
    strategy: "reversal", orderTag: "eth-no3-reversal-v1", ticker: "KXETH15M-SAME",
    side: "yes", wagerCents: 50_000, limitPriceCents: 50, marketOpenTimeMs: 1_800_000,
  };
  const id = ethBigBetOrderId(intent);
  const { store, reservations } = memoryStore([id]);
  const result = await submitEthBigBetIntent({
    intent, store,
    exchange: { async submit() { throw new Error("must not submit"); } },
  });
  assert.equal(result, "blocked_duplicate");
  assert.deepEqual(reservations, []);
});

test("flat sizing produces 840 jump contracts and 1000 reversal contracts at 50 cents", async () => {
  const seen: number[] = [];
  for (const wagerCents of [42_000, 50_000]) {
    const intent: EthBigBetOrderIntent = {
      strategy: wagerCents === 42_000 ? "jump" : "reversal",
      orderTag: wagerCents === 42_000 ? "eth-jump-v1" : "eth-no3-reversal-v1",
      ticker: `KXETH15M-${wagerCents}`, side: "yes", wagerCents,
      limitPriceCents: 50, marketOpenTimeMs: wagerCents,
    };
    const { store } = memoryStore();
    await submitEthBigBetIntent({
      intent, store,
      exchange: { async submit(input) { seen.push(input.contracts); return { exchangeOrderId: "ok" }; } },
    });
  }
  assert.deepEqual(seen, [840, 1000]);
});
