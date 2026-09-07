import assert from "node:assert/strict";
import test from "node:test";
import {
  _setEthBigBetStoreDbForTesting,
  isEthBigBetTerminalStatus,
  reserveEthBigBetIntent,
  reserveEthBigBetIntentWithCapital,
  validateEthBigBetIntentForStorage,
} from "./ethBigBetStore.js";
import { ethBigBetCapitalRiskCents, type EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

const jumpIntent = (overrides: Partial<EthBigBetOrderIntent> = {}): EthBigBetOrderIntent => ({
  strategy: "jump",
  orderTag: "eth-jump-v1",
  ticker: "KXETH15M-26SEP051800-00",
  side: "no",
  wagerCents: 42_000,
  limitPriceCents: 50,
  marketOpenTimeMs: Date.parse("2026-09-06T00:00:00.000Z"),
  ...overrides,
});

const capitalBase = {
  availableBalanceCents: 140_000,
  martingaleReserveCents: 43_470,
  safetyReserveCents: 0,
  otherBigBetReservedCents: 0,
};

test("B/C/D ledger accepts only valid ETH big-bet intents", () => {
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent()), true);
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent({ strategy: "reversal", orderTag: "eth-reversal-v1", side: "yes", wagerCents: 10_000 })), true);
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent({ strategy: "breakout_reversal", orderTag: "eth-no3-upperband-v1", side: "yes", wagerCents: 10_000 })), true);
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent({ ticker: "KXBTC15M-X" })), false);
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent({ wagerCents: 0 })), false);
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent({ limitPriceCents: 100 })), false);
});

test("only rejected and settled rows are terminal", () => {
  assert.equal(isEthBigBetTerminalStatus("reserved"), false);
  assert.equal(isEthBigBetTerminalStatus("submitted"), false);
  assert.equal(isEthBigBetTerminalStatus("submission_unknown"), false);
  assert.equal(isEthBigBetTerminalStatus("rejected"), true);
  assert.equal(isEthBigBetTerminalStatus("settled"), true);
});

test("reservation is exact-strategy+market scoped and fails closed on duplicate", async () => {
  let reserved = false;
  const fakeDb = {
    execute: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn({
      execute: async () => {
        if (reserved) return { rows: [] };
        reserved = true;
        return { rows: [{ id: "KXETH15M-26SEP051800-00:eth-jump-v1" }] };
      },
      transaction: async () => { throw new Error("nested transaction not expected"); },
    }),
  };
  _setEthBigBetStoreDbForTesting(fakeDb as any);
  try {
    assert.equal(await reserveEthBigBetIntent(jumpIntent()), true);
    assert.equal(await reserveEthBigBetIntent(jumpIntent()), false);
    assert.equal(await reserveEthBigBetIntent(jumpIntent({ ticker: "NOT-ETH" })), false);
  } finally {
    _setEthBigBetStoreDbForTesting(null);
  }
});

test("serialized capital admission rechecks existing cross-service risk before insert", async () => {
  let call = 0;
  const fakeDb = {
    execute: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn({
      execute: async () => {
        call += 1;
        if (call === 1) return { rows: [] };
        if (call === 2) return { rows: [{ wager_cents: "10000", limit_price_cents: "50" }] };
        if (call === 3) return { rows: [{ id: "KXETH15M-26SEP051800-00:eth-jump-v1" }] };
        throw new Error("unexpected query");
      },
      transaction: async () => { throw new Error("nested transaction not expected"); },
    }),
  };
  _setEthBigBetStoreDbForTesting(fakeDb as any);
  try {
    const intent = jumpIntent();
    const result = await reserveEthBigBetIntentWithCapital({
      intent,
      capital: capitalBase,
      requestedRiskCents: ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents),
    });
    assert.equal(result, "reserved");
    assert.equal(call, 3);
  } finally {
    _setEthBigBetStoreDbForTesting(null);
  }
});

test("serialized capital admission blocks the second service when shared envelope is exhausted", async () => {
  let call = 0;
  const fakeDb = {
    execute: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn({
      execute: async () => {
        call += 1;
        if (call === 1) return { rows: [] };
        if (call === 2) return { rows: [{ wager_cents: "50000", limit_price_cents: "50" }] };
        throw new Error("insert must not occur when capital is blocked");
      },
      transaction: async () => { throw new Error("nested transaction not expected"); },
    }),
  };
  _setEthBigBetStoreDbForTesting(fakeDb as any);
  try {
    const intent = jumpIntent();
    const result = await reserveEthBigBetIntentWithCapital({
      intent,
      capital: { ...capitalBase, availableBalanceCents: 135_000 },
      requestedRiskCents: ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents),
    });
    assert.equal(result, "capital_blocked");
    assert.equal(call, 2);
  } finally {
    _setEthBigBetStoreDbForTesting(null);
  }
});

test("serialized capital admission inserts only after a clean locked recheck", async () => {
  let call = 0;
  const fakeDb = {
    execute: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn({
      execute: async () => {
        call += 1;
        if (call === 1) return { rows: [] };
        if (call === 2) return { rows: [] };
        if (call === 3) return { rows: [{ id: "KXETH15M-26SEP051800-00:eth-jump-v1" }] };
        throw new Error("unexpected query");
      },
      transaction: async () => { throw new Error("nested transaction not expected"); },
    }),
  };
  _setEthBigBetStoreDbForTesting(fakeDb as any);
  try {
    const intent = jumpIntent();
    const result = await reserveEthBigBetIntentWithCapital({
      intent,
      capital: capitalBase,
      requestedRiskCents: ethBigBetCapitalRiskCents(intent.wagerCents, intent.limitPriceCents),
    });
    assert.equal(result, "reserved");
    assert.equal(call, 3);
  } finally {
    _setEthBigBetStoreDbForTesting(null);
  }
});
