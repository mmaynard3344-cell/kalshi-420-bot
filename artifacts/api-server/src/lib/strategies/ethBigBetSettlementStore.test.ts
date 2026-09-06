import assert from "node:assert/strict";
import test from "node:test";
import {
  _setEthBigBetSettlementStoreDbForTesting,
  listUnresolvedEthBigBetSettlementRowsForTicker,
} from "./ethBigBetSettlementStore.js";

test("settlement reader returns only auditable unresolved B/C row fields", async () => {
  _setEthBigBetSettlementStoreDbForTesting({
    execute: async () => ({ rows: [
      { id: "KXETH15M-X:eth-jump-v1", ticker: "KXETH15M-X", side: "no", kalshi_order_id: "order-1" },
      { id: "KXETH15M-X:eth-no3-reversal-v1", ticker: "KXETH15M-X", side: "yes", kalshi_order_id: null },
    ] }),
  });
  try {
    assert.deepEqual(await listUnresolvedEthBigBetSettlementRowsForTicker("KXETH15M-X"), [
      { id: "KXETH15M-X:eth-jump-v1", ticker: "KXETH15M-X", side: "no", kalshiOrderId: "order-1" },
      { id: "KXETH15M-X:eth-no3-reversal-v1", ticker: "KXETH15M-X", side: "yes", kalshiOrderId: null },
    ]);
  } finally {
    _setEthBigBetSettlementStoreDbForTesting(null);
  }
});

test("settlement reader fails closed on malformed durable rows", async () => {
  _setEthBigBetSettlementStoreDbForTesting({
    execute: async () => ({ rows: [{ id: "x", ticker: "KXETH15M-X", side: "maybe", kalshi_order_id: null }] }),
  });
  try {
    await assert.rejects(() => listUnresolvedEthBigBetSettlementRowsForTicker("KXETH15M-X"));
  } finally {
    _setEthBigBetSettlementStoreDbForTesting(null);
  }
});

test("non-ETH ticker never queries the B/C ledger", async () => {
  let queried = false;
  _setEthBigBetSettlementStoreDbForTesting({ execute: async () => { queried = true; return { rows: [] }; } });
  try {
    assert.deepEqual(await listUnresolvedEthBigBetSettlementRowsForTicker("KXBTC15M-X"), []);
    assert.equal(queried, false);
  } finally {
    _setEthBigBetSettlementStoreDbForTesting(null);
  }
});
