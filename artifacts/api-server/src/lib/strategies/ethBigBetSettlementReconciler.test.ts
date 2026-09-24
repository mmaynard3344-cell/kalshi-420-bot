import assert from "node:assert/strict";
import test from "node:test";
import {
  readEthBigBetSettlementEconomics,
  readEthBigBetTerminalExposureEvidence,
  refreshEthBigBetLongReversalExposureForTicker,
  reconcileEthBigBetAccountingForTicker,
  type EthBigBetSettlementRow,
} from "./ethBigBetSettlementReconciler.js";

const jumpRow: EthBigBetSettlementRow = {
  id: "KXETH15M-26SEP060015-15:eth-jump-v1",
  ticker: "KXETH15M-26SEP060015-15",
  side: "yes",
  kalshiOrderId: "order-jump-1",
};

function oneFillAuth(options: {
  contracts?: string;
  orderFillCount?: string;
  price?: string;
  fee?: string;
  status?: string;
} = {}) {
  const contracts = options.contracts ?? "1000";
  const orderFillCount = options.orderFillCount ?? contracts;
  const price = options.price ?? "0.5000";
  const fee = options.fee ?? "17.5000";
  const status = options.status ?? "executed";
  return async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/orders/")) {
      return { order: { order_id: "order-jump-1", client_order_id: jumpRow.id, status, fill_count_fp: orderFillCount } } as T;
    }
    if (path.startsWith("/portfolio/fills?")) {
      return { fills: [{ fill_id: "fill-1", count_fp: contracts, yes_price_dollars: price, no_price_dollars: String(1 - Number(price)), fee_cost_dollars: fee }] } as T;
    }
    throw new Error(`unexpected path ${path}`);
  };
}

test("filled B/C winner settles from complete authenticated fill evidence", async () => {
  assert.deepEqual(await readEthBigBetSettlementEconomics({
    row: jumpRow,
    officialResult: "yes",
    authFetch: oneFillAuth(),
  }), {
    filledContracts: 1000,
    actualNotionalCents: 50_000,
    actualFeeCents: 1_750,
    fillPriceCents: 50,
    realizedPnlCents: 48_250,
  });
});

test("filled B/C loser records principal plus fee loss", async () => {
  const economics = await readEthBigBetSettlementEconomics({
    row: jumpRow,
    officialResult: "no",
    authFetch: oneFillAuth(),
  });
  assert.equal(economics?.realizedPnlCents, -51_750);
});

test("authoritative canceled zero fill settles accounting-neutral without inferring a loss", async () => {
  let fillRead = false;
  const economics = await readEthBigBetSettlementEconomics({
    row: jumpRow,
    officialResult: "no",
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.startsWith("/portfolio/orders/")) {
        return { order: { order_id: "order-jump-1", status: "canceled", fill_count_fp: "0" } } as T;
      }
      fillRead = true;
      throw new Error("zero fill must not need fills endpoint");
    },
  });
  assert.deepEqual(economics, {
    filledContracts: 0,
    actualNotionalCents: 0,
    actualFeeCents: 0,
    fillPriceCents: null,
    realizedPnlCents: 0,
  });
  assert.equal(fillRead, false);
});

test("empty fills never prove a nonzero order fill", async () => {
  const economics = await readEthBigBetSettlementEconomics({
    row: jumpRow,
    officialResult: "yes",
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.startsWith("/portfolio/orders/")) return { order: { order_id: "order-jump-1", status: "executed", fill_count_fp: "10" } } as T;
      return { fills: [] } as T;
    },
  });
  assert.equal(economics, null);
});

test("fill count mismatch fails closed and retains reservation", async () => {
  assert.equal(await readEthBigBetSettlementEconomics({
    row: jumpRow,
    officialResult: "yes",
    authFetch: oneFillAuth({ contracts: "9", orderFillCount: "10" }),
  }), null);
});

test("missing fee evidence fails closed", async () => {
  const economics = await readEthBigBetSettlementEconomics({
    row: jumpRow,
    officialResult: "yes",
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.startsWith("/portfolio/orders/")) return { order: { order_id: "order-jump-1", status: "executed", fill_count_fp: "1" } } as T;
      return { fills: [{ fill_id: "f", count_fp: "1", yes_price_dollars: "0.5", no_price_dollars: "0.5" }] } as T;
    },
  });
  assert.equal(economics, null);
});

test("submission_unknown may recover one exact exchange order by client ID", async () => {
  const row = { ...jumpRow, kalshiOrderId: null };
  const seen: string[] = [];
  const economics = await readEthBigBetSettlementEconomics({
    row,
    officialResult: "yes",
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      seen.push(path);
      if (path.startsWith("/portfolio/orders?")) {
        return { orders: [{ order_id: "discovered-1", client_order_id: row.id, status: "canceled", fill_count_fp: "0" }] } as T;
      }
      throw new Error("unexpected fill fetch");
    },
  });
  assert.equal(economics?.filledContracts, 0);
  assert.equal(seen.length, 1);
});

test("ambiguous client-order discovery remains unresolved", async () => {
  const row = { ...jumpRow, kalshiOrderId: null };
  assert.equal(await readEthBigBetSettlementEconomics({
    row,
    officialResult: "yes",
    authFetch: async <T>(): Promise<T> => ({ orders: [
      { order_id: "one", client_order_id: row.id, status: "canceled", fill_count_fp: "0" },
      { order_id: "two", client_order_id: row.id, status: "canceled", fill_count_fp: "0" },
    ] } as T),
  }), null);
});

test("reconciler settles complete rows and leaves incomplete rows unresolved without blocking strategy state", async () => {
  const writes: unknown[] = [];
  const incomplete = { ...jumpRow, id: "KXETH15M-26SEP060015-15:eth-no3-reversal-v1", kalshiOrderId: "missing-order" };
  const result = await reconcileEthBigBetAccountingForTicker({
    ticker: jumpRow.ticker,
    officialResult: "yes",
    store: {
      async listUnresolvedForTicker() { return [jumpRow, incomplete]; },
      async settle(input) { writes.push(input); return true; },
    },
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.includes("missing-order")) return { order: null } as T;
      if (path.startsWith("/portfolio/orders/")) return { order: { order_id: "order-jump-1", status: "executed", fill_count_fp: "1" } } as T;
      return { fills: [{ fill_id: "f", count_fp: "1", yes_price_dollars: "0.5", no_price_dollars: "0.5", fee_cost_dollars: "0.02" }] } as T;
    },
  });
  assert.deepEqual(result, { settled: 1, unresolved: 1 });
  assert.equal(writes.length, 1);
});

test("non-ETH ticker is ignored by B/C accounting reconciler", async () => {
  let read = false;
  assert.deepEqual(await reconcileEthBigBetAccountingForTicker({
    ticker: "KXBTC15M-X",
    officialResult: "yes",
    store: {
      async listUnresolvedForTicker() { read = true; return []; },
      async settle() { return true; },
    },
  }), { settled: 0, unresolved: 0 });
  assert.equal(read, false);
});


test("terminal canceled partial fill produces reduced active risk from authenticated fills", async () => {
  const row = { ...jumpRow, kalshiOrderId: "partial-order" };
  const evidence = await readEthBigBetTerminalExposureEvidence({
    row,
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.startsWith("/portfolio/orders/")) {
        return { order: {
          order_id: "partial-order",
          client_order_id: row.id,
          status: "canceled",
          fill_count_fp: "2",
        } } as T;
      }
      if (path.startsWith("/portfolio/fills?")) {
        return { fills: [{
          fill_id: "partial-fill",
          count_fp: "2",
          yes_price_dollars: "0.40",
          no_price_dollars: "0.60",
          fee_cost_dollars: "0.03",
        }] } as T;
      }
      throw new Error("unexpected path");
    },
  });
  assert.deepEqual(evidence, {
    terminalStatus: "canceled",
    filledContracts: 2,
    actualNotionalCents: 80,
    actualFeeCents: 3,
    activeRiskCents: 83,
    terminalZeroFill: false,
  });
});

test("open partial fill retains full shared reservation by returning no shrink evidence", async () => {
  const row = { ...jumpRow, kalshiOrderId: "open-partial-order" };
  const evidence = await readEthBigBetTerminalExposureEvidence({
    row,
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.startsWith("/portfolio/orders/")) {
        return { order: {
          order_id: "open-partial-order",
          client_order_id: row.id,
          status: "resting",
          fill_count_fp: "2",
        } } as T;
      }
      throw new Error("fills must not be read for nonterminal partial order");
    },
  });
  assert.equal(evidence, null);
});

test("risk refresh writes filled_unsettled amount for terminal partial fill", async () => {
  const adjustments: unknown[] = [];
  const result = await refreshEthBigBetLongReversalExposureForTicker({
    ticker: jumpRow.ticker,
    store: { async listUnresolvedForTicker() { return [{ ...jumpRow, kalshiOrderId: "partial-order-2" }]; } },
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.startsWith("/portfolio/orders/")) {
        return { order: { order_id: "partial-order-2", status: "canceled", fill_count_fp: "1" } } as T;
      }
      return { fills: [{
        fill_id: "p2",
        count_fp: "1",
        yes_price_dollars: "0.45",
        no_price_dollars: "0.55",
        fee_cost_dollars: "0.02",
      }] } as T;
    },
    adjustRisk: async (input) => { adjustments.push(input); return true; },
  });
  assert.deepEqual(result, { adjusted: 1, retained: 0 });
  assert.equal((adjustments[0] as { activeRiskCents: number }).activeRiskCents, 47);
  assert.equal((adjustments[0] as { terminalZeroFill: boolean }).terminalZeroFill, false);
});

test("terminal zero fill releases shared reservation during pre-settlement refresh", async () => {
  const adjustments: unknown[] = [];
  const result = await refreshEthBigBetLongReversalExposureForTicker({
    ticker: jumpRow.ticker,
    store: { async listUnresolvedForTicker() { return [{ ...jumpRow, kalshiOrderId: "zero-order" }]; } },
    authFetch: async <T>(): Promise<T> => ({
      order: { order_id: "zero-order", status: "canceled", fill_count_fp: "0" },
    } as T),
    adjustRisk: async (input) => { adjustments.push(input); return true; },
  });
  assert.deepEqual(result, { adjusted: 1, retained: 0 });
  assert.equal((adjustments[0] as { activeRiskCents: number }).activeRiskCents, 0);
  assert.equal((adjustments[0] as { terminalZeroFill: boolean }).terminalZeroFill, true);
});
