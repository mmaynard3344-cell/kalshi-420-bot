import assert from "node:assert/strict";
import test from "node:test";
import {
  sweepUnresolvedEthBigBetAccounting,
} from "./ethBigBetAccountingSweep.js";

const noRecovery = async () => 0;
const noExposureRefresh = async () => ({ adjusted: 0, retained: 0 });

test("accounting sweep recovers stale reserved rows before ticker discovery", async () => {
  const sequence: string[] = [];
  const result = await sweepUnresolvedEthBigBetAccounting({
    nowMs: 123_456,
    recoverReserved: async (nowMs) => {
      sequence.push(`recover:${nowMs}`);
      return 2;
    },
    refreshExposure: noExposureRefresh,
    listTickers: async () => {
      sequence.push("list");
      return [];
    },
  });
  assert.deepEqual(sequence, ["recover:123456", "list"]);
  assert.equal(result.recoveredReservedRows, 2);
  assert.equal(result.errors, 0);
});

test("accounting sweep reconciles only tickers with authoritative YES/NO", async () => {
  const reconciled: Array<[string, string]> = [];
  const result = await sweepUnresolvedEthBigBetAccounting({
    recoverReserved: noRecovery,
    refreshExposure: noExposureRefresh,
    listTickers: async (limit) => {
      assert.equal(limit, 50);
      return ["KXETH15M-YES", "KXETH15M-PENDING", "KXETH15M-NO"];
    },
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.includes("YES")) return { market: { result: "yes" } } as T;
      if (path.includes("NO")) return { market: { result: "no" } } as T;
      return { market: { result: "" } } as T;
    },
    reconcile: async (ticker, result) => {
      reconciled.push([ticker, result]);
      return { settled: 1, unresolved: 0 };
    },
  });
  assert.deepEqual(reconciled, [
    ["KXETH15M-YES", "yes"],
    ["KXETH15M-NO", "no"],
  ]);
  assert.deepEqual(result, {
    recoveredReservedRows: 0,
    tickersChecked: 3,
    tickersUnsettled: 1,
    settledRows: 2,
    unresolvedRows: 0,
    exposureAdjustedRows: 0,
    exposureRetainedRows: 0,
    errors: 0,
  });
});

test("accounting sweep leaves incomplete reconciliation unresolved for later retry", async () => {
  const result = await sweepUnresolvedEthBigBetAccounting({
    recoverReserved: noRecovery,
    refreshExposure: noExposureRefresh,
    listTickers: async () => ["KXETH15M-X"],
    authFetch: async <T>(): Promise<T> => ({ market: { result: "yes" } } as T),
    reconcile: async () => ({ settled: 0, unresolved: 2 }),
  });
  assert.equal(result.settledRows, 0);
  assert.equal(result.unresolvedRows, 2);
  assert.equal(result.errors, 0);
});

test("reserved recovery failure is isolated and submitted rows still reconcile", async () => {
  const result = await sweepUnresolvedEthBigBetAccounting({
    recoverReserved: async () => { throw new Error("recovery db failure"); },
    refreshExposure: noExposureRefresh,
    listTickers: async () => ["KXETH15M-X"],
    authFetch: async <T>(): Promise<T> => ({ market: { result: "yes" } } as T),
    reconcile: async () => ({ settled: 1, unresolved: 0 }),
  });
  assert.equal(result.errors, 1);
  assert.equal(result.settledRows, 1);
});

test("market API failure is isolated and later tickers continue", async () => {
  const reconciled: string[] = [];
  const result = await sweepUnresolvedEthBigBetAccounting({
    recoverReserved: noRecovery,
    refreshExposure: noExposureRefresh,
    listTickers: async () => ["KXETH15M-BAD", "KXETH15M-GOOD"],
    authFetch: async <T>(_method: string, path: string): Promise<T> => {
      if (path.includes("BAD")) throw new Error("network");
      return { market: { result: "yes" } } as T;
    },
    reconcile: async (ticker) => {
      reconciled.push(ticker);
      return { settled: 1, unresolved: 0 };
    },
  });
  assert.deepEqual(reconciled, ["KXETH15M-GOOD"]);
  assert.equal(result.errors, 1);
  assert.equal(result.settledRows, 1);
});

test("ticker discovery failure fails isolated with no market reads", async () => {
  let marketRead = false;
  const result = await sweepUnresolvedEthBigBetAccounting({
    recoverReserved: noRecovery,
    refreshExposure: noExposureRefresh,
    listTickers: async () => { throw new Error("db unavailable"); },
    authFetch: async <T>(): Promise<T> => { marketRead = true; return {} as T; },
  });
  assert.equal(marketRead, false);
  assert.deepEqual(result, {
    recoveredReservedRows: 0,
    tickersChecked: 0,
    tickersUnsettled: 0,
    settledRows: 0,
    unresolvedRows: 0,
    exposureAdjustedRows: 0,
    exposureRetainedRows: 0,
    errors: 1,
  });
});

test("custom sweep limit is passed through to bounded ticker discovery", async () => {
  let seenLimit: number | undefined;
  await sweepUnresolvedEthBigBetAccounting({
    limit: 7,
    recoverReserved: noRecovery,
    refreshExposure: noExposureRefresh,
    listTickers: async (limit) => { seenLimit = limit; return []; },
  });
  assert.equal(seenLimit, 7);
});
