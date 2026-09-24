import assert from "node:assert/strict";
import test from "node:test";
import {
  BK_CAPITAL_SERVICES,
  evaluateBkCapitalAdmission,
  evaluateBkFreshBalanceOnly,
  isBkFreshBalanceCapitalPolicyEnabled,
  bkCapitalTelemetry,
  _setBkFreshBalanceReadForTesting,
  readBkFreshSameShardBalance,
} from "./bkFreshBalanceCapitalPolicy.js";
import {
  _setEthBigBetStoreDbForTesting,
  reserveEthBigBetIntentWithCapital,
} from "./ethBigBetStore.js";
import { ethBigBetCapitalRiskCents, type EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

const base = {
  service: "B" as const,
  ticker: "KXETH15M-TEST",
  exchangeIndex: 2,
  requestedRiskCents: 77,
  freshAvailableBalanceCents: 77,
  oldPolicyDecision: "block" as const,
  oldPolicyBlocker: "insufficient_unreserved_capital",
};

test("flag defaults false and false preserves the old capital decision", () => {
  assert.equal(isBkFreshBalanceCapitalPolicyEnabled(undefined), false);
  const result = evaluateBkCapitalAdmission({ ...base, flagRaw: undefined });
  assert.equal(result.newPolicyDecision, "allow");
  assert.equal(result.finalDecision, "block");
  assert.equal(result.finalAllowed, false);
});

test("flag true permits fresh balance at fee-inclusive requested risk despite old reserve block", () => {
  const result = evaluateBkCapitalAdmission({ ...base, flagRaw: "true" });
  assert.equal(result.oldPolicyDecision, "block");
  assert.equal(result.newPolicyDecision, "allow");
  assert.equal(result.finalDecision, "allow");
  assert.equal(result.finalAllowed, true);
});

test("flag true blocks when fresh balance is one cent short", () => {
  const result = evaluateBkCapitalAdmission({
    ...base,
    freshAvailableBalanceCents: 76,
    flagRaw: "true",
  });
  assert.equal(result.newPolicyDecision, "block");
  assert.equal(result.finalDecision, "block");
});

test("fresh balance unavailable or malformed fails closed", () => {
  assert.equal(evaluateBkFreshBalanceOnly(null, 77), "unavailable");
  assert.equal(evaluateBkFreshBalanceOnly(Number.NaN, 77), "unavailable");
  assert.equal(evaluateBkFreshBalanceOnly(77, 0), "unavailable");
});

test("central policy scope is exactly B through K and excludes A", () => {
  assert.deepEqual(BK_CAPITAL_SERVICES, ["B","C","D","E","F","G","H","I","J","K"]);
  assert.equal((BK_CAPITAL_SERVICES as readonly string[]).includes("A"), false);
});

test("B/C durable reservation recheck uses fresh-only policy when flag is true", async () => {
  const old = process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"];
  process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"] = "true";
  let call = 0;
  const fakeDb = {
    execute: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn({
      execute: async () => {
        call += 1;
        if (call === 1) return { rows: [] }; // advisory lock
        if (call === 2) return { rows: [{ id: "KXETH15M-TEST:eth-jump-v1" }] }; // insert
        throw new Error("fresh-only path must not query unresolved local risk");
      },
      transaction: async () => { throw new Error("nested transaction not expected"); },
    }),
  };
  const intent: EthBigBetOrderIntent = {
    strategy: "jump",
    orderTag: "eth-jump-v1",
    ticker: "KXETH15M-TEST",
    side: "no",
    wagerCents: 50,
    limitPriceCents: 50,
    marketOpenTimeMs: 1,
  };
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  _setEthBigBetStoreDbForTesting(fakeDb as any);
  try {
    assert.equal(await reserveEthBigBetIntentWithCapital({
      intent,
      capital: {
        availableBalanceCents: requestedRiskCents,
        martingaleReserveCents: 33_120,
        safetyReserveCents: 207,
        otherBigBetReservedCents: 99_999,
      },
      requestedRiskCents,
    }), "reserved");
    assert.equal(call, 2);
  } finally {
    _setEthBigBetStoreDbForTesting(null);
    if (old == null) delete process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"];
    else process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"] = old;
  }
});

test("flag true durable reservation recheck blocks one cent short", async () => {
  const old = process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"];
  process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"] = "true";
  let call = 0;
  const fakeDb = {
    execute: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn({
      execute: async () => {
        call += 1;
        if (call === 1) return { rows: [] }; // advisory lock
        throw new Error("insert must not occur");
      },
      transaction: async () => { throw new Error("nested transaction not expected"); },
    }),
  };
  const intent: EthBigBetOrderIntent = {
    strategy: "jump",
    orderTag: "eth-jump-v1",
    ticker: "KXETH15M-TEST",
    side: "no",
    wagerCents: 50,
    limitPriceCents: 50,
    marketOpenTimeMs: 1,
  };
  const requestedRiskCents = ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents);
  _setEthBigBetStoreDbForTesting(fakeDb as any);
  try {
    assert.equal(await reserveEthBigBetIntentWithCapital({
      intent,
      capital: {
        availableBalanceCents: requestedRiskCents - 1,
        martingaleReserveCents: 0,
        safetyReserveCents: 0,
        otherBigBetReservedCents: 0,
      },
      requestedRiskCents,
    }), "capital_blocked");
    assert.equal(call, 1);
  } finally {
    _setEthBigBetStoreDbForTesting(null);
    if (old == null) delete process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"];
    else process.env["BK_FRESH_BALANCE_CAPITAL_POLICY"] = old;
  }
});

test("telemetry names the enabled comparison as fresh_balance_policy_decision", () => {
  const decision = evaluateBkCapitalAdmission({ ...base, flagRaw: "true" });
  assert.deepEqual(bkCapitalTelemetry(decision, "not_attempted"), {
    service: "B",
    ticker: "KXETH15M-TEST",
    exchange_index: 2,
    requested_risk_cents: 77,
    fresh_available_balance_cents: 77,
    old_policy_decision: "block",
    bk_flag_enabled: true,
    fresh_balance_policy_decision: "allow",
    final_decision: "allow",
    order_result: "not_attempted",
  });
});

test("fresh same-shard reader rejects invalid exchange index without calling Kalshi", async () => {
  let called = false;
  _setBkFreshBalanceReadForTesting((async () => { called = true; return { value: { balance: 77 }, stale: false }; }) as any);
  try {
    assert.equal(await readBkFreshSameShardBalance(-1), null);
    assert.equal(called, false);
  } finally {
    _setBkFreshBalanceReadForTesting(null);
  }
});

test("fresh same-shard reader fails closed on stale, malformed, or failed balance reads", async () => {
  try {
    _setBkFreshBalanceReadForTesting((async () => ({ value: { balance: 77 }, stale: true })) as any);
    assert.equal(await readBkFreshSameShardBalance(2), null);

    _setBkFreshBalanceReadForTesting((async () => ({ value: { balance: "77" }, stale: false })) as any);
    assert.equal(await readBkFreshSameShardBalance(2), null);

    _setBkFreshBalanceReadForTesting((async () => { throw new Error("unavailable"); }) as any);
    assert.equal(await readBkFreshSameShardBalance(2), null);

    _setBkFreshBalanceReadForTesting((async (exchangeIndex: number) => {
      assert.equal(exchangeIndex, 2);
      return { value: { balance: 77 }, stale: false };
    }) as any);
    assert.equal(await readBkFreshSameShardBalance(2), 77);
  } finally {
    _setBkFreshBalanceReadForTesting(null);
  }
});
