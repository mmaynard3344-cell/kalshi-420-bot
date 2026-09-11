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

test("B/C ledger accepts only valid ETH big-bet intents", () => {
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent()), true);
  assert.equal(validateEthBigBetIntentForStorage(jumpIntent({ strategy: "reversal", orderTag: "eth-reversal-v1", side: "yes", wagerCents: 50_000 })), true);
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
        if (call === 1) return { rows: [] }; // pg_advisory_xact_lock
        if (call === 2) return { rows: [{ wager_cents: "50000", limit_price_cents: "50" }] }; // C already reserved
        if (call === 3) return { rows: [{ id: "KXETH15M-26SEP051800-00:eth-jump-v1" }] }; // B insert
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
    // $1,400 - $434.70 A reserve - $517.50 existing C = $447.80,
    // leaving enough for B's $434.70 fee-inclusive risk.
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
        if (call === 1) return { rows: [] }; // lock
        if (call === 2) return { rows: [{ wager_cents: "50000", limit_price_cents: "50" }] }; // prior C
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
    // $1,350 - $434.70 A reserve - $517.50 existing C = $397.80,
    // below B's $434.70 fee-inclusive risk.
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
        if (call === 1) return { rows: [] }; // lock
        if (call === 2) return { rows: [] }; // no unresolved B/C
        if (call === 3) return { rows: [{ id: "KXETH15M-26SEP051800-00:eth-jump-v1" }] }; // insert
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
