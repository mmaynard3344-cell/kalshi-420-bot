import assert from "node:assert/strict";
import test from "node:test";
import {
  _setEthBigBetStoreDbForTesting,
  isEthBigBetTerminalStatus,
  reserveEthBigBetIntent,
  validateEthBigBetIntentForStorage,
} from "./ethBigBetStore.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

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
