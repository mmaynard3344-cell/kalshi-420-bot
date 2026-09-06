import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH_BIG_BET_MARTINGALE_RESERVE_CENTS,
  ETH_BIG_BET_SAFETY_RESERVE_CENTS,
  ETH_BIG_BET_TOTAL_PROTECTED_BASE_CENTS,
  readApprovedEthBigBetCapitalBase,
} from "./ethBigBetApprovedCapitalProvider.js";
import {
  _setEthBigBetCapitalFactsBalanceForTesting,
  _setEthBigBetCapitalFactsDbForTesting,
} from "./ethBigBetCapitalFacts.js";

function reset(): void {
  _setEthBigBetCapitalFactsDbForTesting(null);
  _setEthBigBetCapitalFactsBalanceForTesting(null);
}

test("approved B/C reserve policy is centralized at 434.70 + 517.50", () => {
  assert.equal(ETH_BIG_BET_MARTINGALE_RESERVE_CENTS, 43_470);
  assert.equal(ETH_BIG_BET_SAFETY_RESERVE_CENTS, 51_750);
  assert.equal(ETH_BIG_BET_TOTAL_PROTECTED_BASE_CENTS, 95_220);
});

test("approved provider combines fresh balance, unresolved exposure, and approved reserves", async () => {
  _setEthBigBetCapitalFactsBalanceForTesting((async (exchangeIndex: number) => {
    assert.equal(exchangeIndex, 2);
    return { value: { balance: 200_000 }, stale: false };
  }) as any);
  _setEthBigBetCapitalFactsDbForTesting({
    execute: async () => ({ rows: [{ wager_cents: "42000", limit_price_cents: "50" }] }),
  });
  try {
    assert.deepEqual(await readApprovedEthBigBetCapitalBase(2), {
      availableBalanceCents: 200_000,
      martingaleReserveCents: 43_470,
      safetyReserveCents: 51_750,
      otherBigBetReservedCents: 43_470,
    });
  } finally {
    reset();
  }
});

test("approved provider fails closed on invalid, stale, or unavailable evidence", async () => {
  assert.equal(await readApprovedEthBigBetCapitalBase(-1), null);

  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => ({ rows: [] }) });
  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 200_000 }, stale: true })) as any);
  try {
    assert.equal(await readApprovedEthBigBetCapitalBase(0), null);
  } finally {
    reset();
  }

  _setEthBigBetCapitalFactsDbForTesting({ execute: async () => { throw new Error("db unavailable"); } });
  _setEthBigBetCapitalFactsBalanceForTesting((async () => ({ value: { balance: 200_000 }, stale: false })) as any);
  try {
    assert.equal(await readApprovedEthBigBetCapitalBase(0), null);
  } finally {
    reset();
  }
});
