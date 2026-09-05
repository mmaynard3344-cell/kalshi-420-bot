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

test("capital facts combine a fresh routed balance with conservative unresolved B/C risk", async () => {
  _setEthBigBetCapitalFactsBalanceForTesting((async (exchangeIndex: number) => {
    assert.equal(exchangeIndex, 3);
    return { value: { balance: 250_000 }, stale: false };
  }) as any);
  _setEthBigBetCapitalFactsDbForTesting({
    execute: async () => ({ rows: [{ reserved_cents: "92000" }] }),
  });
  try {
    const facts = await readEthBigBetCapitalFacts(3);
    assert.ok(facts);
    assert.equal(facts.exchangeIndex, 3);
    assert.equal(facts.availableBalanceCents, 250_000);
    assert.equal(facts.otherBigBetReservedCents, 92_000);
    assert.equal(Number.isSafeInteger(facts.observedAtMs), true);
  } finally {
    reset();
  }
});

test("stale or malformed routed balance fails closed", async () => {
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [{ reserved_cents: "0" }] }) });
  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: true })) as any);
  try {
    assert.equal(await readEthBigBetCapitalFacts(0), null);
  } finally {
    reset();
  }

  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [{ reserved_cents: "0" }] }) });
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
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [{ reserved_cents: "-1" }] }) });
  try {
    assert.equal(await readEthBigBetCapitalFacts(1), null);
  } finally {
    reset();
  }

  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 100_000 }, stale: false })) as any);
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [{ reserved_cents: "not-a-number" }] }) });
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
  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [{ reserved_cents: "0" }] }) });
  try {
    assert.equal(await readEthBigBetCapitalFacts(2), null);
  } finally {
    reset();
  }
});
