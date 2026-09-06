import assert from "node:assert/strict";
import test from "node:test";
import {
  _setEthBigBetCapitalFactsBalanceForTesting,
  _setEthBigBetCapitalFactsDbForTesting,
  readEthBigBetCapitalFacts,
} from "./ethBigBetCapitalFacts.js";

function reset(): void {
  _setEthBigBetCapitalFactsDbForTesting(null);
  _setEthBigBetCapitalFactsBalanceForTesting(null);
}

test("capital facts combine fresh routed balance with fee-inclusive unresolved B/C risk", async () => {
  _setEthBigBetCapitalFactsBalanceForTesting((async (exchangeIndex: number) => {
    assert.equal(exchangeIndex, 3);
    return { value: { balance: 250_000 }, stale: false };
  }) as any);
  _setEthBigBetCapitalFactsDbForTesting({
    execute: async () => ({ rows: [
      { wager_cents: "42000", limit_price_cents: "50" },
      { wager_cents: "50000", limit_price_cents: "50" },
    ] }),
  });
  try {
    const facts = await readEthBigBetCapitalFacts(3);
    assert.ok(facts);
    assert.equal(facts.exchangeIndex, 3);
    assert.equal(facts.availableBalanceCents, 250_000);
    assert.equal(facts.otherBigBetReservedCents, 95_220);
    assert.equal(Number.isSafeInteger(facts.observedAtMs), true);
  } finally {
    reset();
  }
});

test("empty unresolved ledger reserves zero B/C capital", async () => {
  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [] }) });
  try {
    const facts = await readEthBigBetCapitalFacts(0);
    assert.ok(facts);
    assert.equal(facts.otherBigBetReservedCents, 0);
  } finally {
    reset();
  }
});

test("stale or malformed routed balance fails closed", async () => {
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [] }) });
  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: true })) as any);
  try {
    assert.equal(await readEthBigBetCapitalFacts(0), null);
  } finally {
    reset();
  }

  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [] }) });
  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: "100000" }, stale: false })) as any);
  try {
    assert.equal(await readEthBigBetCapitalFacts(0), null);
  } finally {
    reset();
  }
});

test("invalid exchange routing and malformed unresolved exposure fail closed", async () => {
  assert.equal(await readEthBigBetCapitalFacts(-1), null);

  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [
    { wager_cents: "-1", limit_price_cents: "50" },
  ] }) });
  try {
    assert.equal(await readEthBigBetCapitalFacts(1), null);
  } finally {
    reset();
  }

  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [
    { wager_cents: "42000", limit_price_cents: "not-a-number" },
  ] }) });
  try {
    assert.equal(await readEthBigBetCapitalFacts(1), null);
  } finally {
    reset();
  }

  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [
    { wager_cents: "42000", limit_price_cents: "100" },
  ] }) });
  try {
    assert.equal(await readEthBigBetCapitalFacts(1), null);
  } finally {
    reset();
  }
});

test("database or balance-read failure returns null rather than guessing capital", async () => {
  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => { throw new Error("db down"); } });
  try {
    assert.equal(await readEthBigBetCapitalFacts(2), null);
  } finally {
    reset();
  }

  _setEthBigBetCapitalFactsBalanceForTesting((async () => { throw new Error("balance unavailable"); }) as any);
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [] }) });
  try {
    assert.equal(await readEthBigBetCapitalFacts(2), null);
  } finally {
    reset();
  }
});
