import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  _setEthBigBetSettlementStoreDbForTesting,
  ETH_BIG_BET_STALE_RESERVED_RECOVERY_AGE_MS,
  listUnresolvedEthBigBetSettlementRowsForTicker,
  listUnresolvedEthBigBetTickers,
  promoteStaleReservedEthBigBetsToSubmissionUnknown,
} from "./ethBigBetSettlementStore.js";

function existingLedgerDb(dataRows: Array<Record<string, unknown>>) {
  let call = 0;
  return {
    execute: async () => {
      call++;
      if (call === 1) return { rows: [{ table_name: "eth_big_bet_orders" }] };
      return { rows: dataRows };
    },
  };
}

test("settlement reader returns only auditable unresolved B/C row fields", async () => {
  _setEthBigBetSettlementStoreDbForTesting(existingLedgerDb([
    { id: "KXETH15M-X:eth-jump-v1", ticker: "KXETH15M-X", side: "no", kalshi_order_id: "order-1" },
    { id: "KXETH15M-X:eth-no3-reversal-v1", ticker: "KXETH15M-X", side: "yes", kalshi_order_id: null },
  ]));
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
  _setEthBigBetSettlementStoreDbForTesting(existingLedgerDb([
    { id: "x", ticker: "KXETH15M-X", side: "maybe", kalshi_order_id: null },
  ]));
  try {
    await assert.rejects(() => listUnresolvedEthBigBetSettlementRowsForTicker("KXETH15M-X"));
  } finally {
    _setEthBigBetSettlementStoreDbForTesting(null);
  }
});

test("dormant accounting returns empty when B/C ledger has never been created", async () => {
  let calls = 0;
  _setEthBigBetSettlementStoreDbForTesting({
    execute: async () => {
      calls++;
      return { rows: [{ table_name: null }] };
    },
  });
  try {
    assert.deepEqual(await listUnresolvedEthBigBetSettlementRowsForTicker("KXETH15M-X"), []);
    assert.deepEqual(await listUnresolvedEthBigBetTickers(), []);
    assert.equal(await promoteStaleReservedEthBigBetsToSubmissionUnknown(ETH_BIG_BET_STALE_RESERVED_RECOVERY_AGE_MS), 0);
    assert.equal(calls, 3);
  } finally {
    _setEthBigBetSettlementStoreDbForTesting(null);
  }
});

test("stale reserved crash recovery uses one full 15-minute age and remains nonterminal", async () => {
  assert.equal(ETH_BIG_BET_STALE_RESERVED_RECOVERY_AGE_MS, 15 * 60_000);
  let call = 0;
  _setEthBigBetSettlementStoreDbForTesting({
    execute: async () => {
      call++;
      if (call === 1) return { rows: [{ table_name: "eth_big_bet_orders" }] };
      return { rows: [{ id: "KXETH15M-X:eth-jump-v1" }, { id: "KXETH15M-Y:eth-no3-reversal-v1" }] };
    },
  });
  try {
    assert.equal(
      await promoteStaleReservedEthBigBetsToSubmissionUnknown(2 * ETH_BIG_BET_STALE_RESERVED_RECOVERY_AGE_MS),
      2,
    );
    assert.equal(call, 2);
  } finally {
    _setEthBigBetSettlementStoreDbForTesting(null);
  }
});

test("stale reserved recovery SQL cannot broaden beyond unacknowledged aged reservations", () => {
  const source = readFileSync("src/lib/strategies/ethBigBetSettlementStore.ts", "utf8");
  const start = source.indexOf("export async function promoteStaleReservedEthBigBetsToSubmissionUnknown");
  const end = source.indexOf("export async function listUnresolvedEthBigBetTickers", start);
  assert.ok(start >= 0 && end > start);
  const recovery = source.slice(start, end);
  assert.match(recovery, /SET status='submission_unknown'/);
  assert.match(recovery, /WHERE status='reserved'/);
  assert.match(recovery, /kalshi_order_id IS NULL/);
  assert.match(recovery, /created_at_ms <= \$\{cutoffMs\}/);
  assert.doesNotMatch(recovery, /status='rejected'/);
  assert.doesNotMatch(recovery, /status='settled'/);
  assert.doesNotMatch(recovery, /filled_contracts/);
  assert.doesNotMatch(recovery, /realized_pnl_cents/);
});

test("reserved crash recovery rejects nonsensical timestamps rather than guessing", async () => {
  await assert.rejects(() => promoteStaleReservedEthBigBetsToSubmissionUnknown(-1));
  await assert.rejects(() => promoteStaleReservedEthBigBetsToSubmissionUnknown(1));
});

test("unresolved ticker reader is bounded and validates ETH identities", async () => {
  _setEthBigBetSettlementStoreDbForTesting(existingLedgerDb([
    { ticker: "KXETH15M-ONE" },
    { ticker: "KXETH15M-TWO" },
  ]));
  try {
    assert.deepEqual(await listUnresolvedEthBigBetTickers(10), ["KXETH15M-ONE", "KXETH15M-TWO"]);
  } finally {
    _setEthBigBetSettlementStoreDbForTesting(null);
  }
  await assert.rejects(() => listUnresolvedEthBigBetTickers(0));
  await assert.rejects(() => listUnresolvedEthBigBetTickers(501));
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
