import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateProtectiveExit,
  restoreArmedPositions,
  startProtectiveExitRestoreCoordinator,
  _getEthMartingaleOrderIdsByTickerForTesting,
  _getMixedEthStrategyOwnershipTickersForTesting,
  _resetProtectiveExitForTesting,
  _getRestoredArmedTickersForTesting,
  _setProtectiveExitAuthFetchForTesting,
  _setProtectiveExitBookFetchForTesting,
  _setProtectiveExitPositionLookupForTesting,
  _setProtectiveExitStoreForTesting,
} from "./protectiveExit.js";

type Audit = Record<string, unknown>;
let records: Audit[];
let posts: Record<string, unknown>[];
let postCalls: Array<{ method: string; path: string }>;
let position = 5;
let persist = true;
let bookDelay = 0;

function install(): void {
  records = []; posts = []; postCalls = []; position = 5; persist = true; bookDelay = 0;
  process.env["PROTECTIVE_EXIT_ENABLED"] = "true";
  _setProtectiveExitPositionLookupForTesting(async () => position);
  _setProtectiveExitBookFetchForTesting(async () => {
    if (bookDelay) await new Promise((resolve) => setTimeout(resolve, bookDelay));
    return { orderbook_fp: { yes_dollars: [["0.8100", "10.00"]], no_dollars: [["0.8100", "10.00"]] } };
  });
  _setProtectiveExitStoreForTesting(
    async (record) => { if (persist) records.push(record as unknown as Audit); return persist; },
    async (id, patch) => {
      const record = records.find((candidate) => candidate.id === id);
      if (record) Object.assign(record, patch);
      return persist;
    },
  );
  _setProtectiveExitAuthFetchForTesting((async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    postCalls.push({ method, path });
    posts.push(body as Record<string, unknown>);
    return { order: { order_id: "exit-1", status: "filled", fill_count_fp: "5.00", remaining_count_fp: "0.00" } } as T;
  }));
}

test.afterEach(() => {
  _resetProtectiveExitForTesting();
  delete process.env["PROTECTIVE_EXIT_ENABLED"];
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("startup restore waits for a complete durable snapshot, then installs one protected loop after recovery", async () => {
  install();
  let readRound = 0;
  let activeReads = 0;
  let maxConcurrentReads = 0;
  const retries: Array<() => void> = [];
  let retrySchedules = 0;
  let installedSnapshots = 0;
  let monitorStarts = 0;
  let monitorTicks = 0;

  const enterRead = async <T>(value: T): Promise<T> => {
    activeReads++;
    maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
    await Promise.resolve();
    activeReads--;
    return value;
  };
  startProtectiveExitRestoreCoordinator({
    loadPositions: async () => enterRead(readRound === 0 ? null : [
      { ticker: "KXETH15M-MIXED", side: "yes" as const, quantity: 4 },
    ]),
    loadLegacyTickers: async () => enterRead(readRound === 0 ? null : [
      "KXETH15M-MIXED",
      "KXBTC15M-LEGACY",
    ]),
    loadEthMartingaleOrders: async () => enterRead(readRound === 0 ? null : [
      { ticker: "KXETH15M-MIXED", kalshiOrderId: "eth-owned-1" },
      { ticker: "KXETH15M-MARTINGALE", kalshiOrderId: "eth-owned-2" },
    ]),
    retryIntervalMs: 1,
    installSnapshot: (entries, ethOrders) => {
      installedSnapshots++;
      restoreArmedPositions(entries, ethOrders);
    },
    monitor: async () => { monitorTicks++; },
    startMonitorLoop: () => {
      monitorStarts++;
      return { unref: () => undefined };
    },
    scheduleRetry: (callback) => {
      retrySchedules++;
      retries.push(callback);
      return { unref: () => undefined };
    },
  });

  await flushPromises();
  assert.equal(installedSnapshots, 0, "a partial outage must not overwrite protective state");
  assert.equal(retrySchedules, 1, "only one retry is armed after the failed complete read");
  assert.equal(maxConcurrentReads, 3, "one snapshot reads its independent sources in parallel");
  const retry = retries.at(-1);
  assert.ok(retry);

  readRound = 1;
  retry();
  retry(); // A duplicated timer delivery must not overlap or reinstall recovery state.
  await flushPromises();

  assert.equal(installedSnapshots, 1, "only the first complete recovered snapshot is installed");
  assert.equal(monitorStarts, 1, "recovery starts exactly one restored monitor loop");
  assert.equal(monitorTicks, 1, "the restored loop performs one immediate coverage pass");
  assert.equal(retrySchedules, 1, "recovery does not schedule another retry");
  assert.equal(maxConcurrentReads, 3, "duplicate delivery did not start a second read snapshot");
  assert.deepEqual(
    [..._getRestoredArmedTickersForTesting()].sort(),
    ["KXBTC15M-LEGACY", "KXETH15M-MIXED"],
  );
  assert.deepEqual(
    [..._getEthMartingaleOrderIdsByTickerForTesting().get("KXETH15M-MIXED") ?? []],
    ["eth-owned-1"],
    "ETH martingale ownership is retained in the recovered snapshot",
  );
  assert.deepEqual(
    [..._getMixedEthStrategyOwnershipTickersForTesting()],
    ["KXETH15M-MIXED"],
    "mixed ETH ownership remains excluded from legacy protective exits",
  );
});

test("startup restore waits for sibling durable reads after one read rejects before retrying", async () => {
  install();
  let round = 0;
  const slowReadResolvers: Array<() => void> = [];
  const retries: Array<() => void> = [];
  let installs = 0;

  startProtectiveExitRestoreCoordinator({
    loadPositions: async () => {
      if (round === 0) throw new Error("database temporarily unavailable");
      return [];
    },
    loadLegacyTickers: async () => {
      if (round > 0) return [];
      return new Promise<string[]>((resolve) => {
        slowReadResolvers.push(() => resolve([]));
      });
    },
    loadEthMartingaleOrders: async () => [],
    retryIntervalMs: 1,
    installSnapshot: () => { installs++; },
    scheduleRetry: (callback) => {
      retries.push(callback);
      return { unref: () => undefined };
    },
  });

  await flushPromises();
  assert.equal(retries.length, 0, "a rejected read must wait for its slow sibling before arming retry");
  const releaseSlowRead = slowReadResolvers.at(-1);
  assert.ok(releaseSlowRead);

  releaseSlowRead();
  await flushPromises();
  assert.equal(retries.length, 1, "retry is armed only after every read from the failed snapshot settles");

  round = 1;
  const retry = retries.at(-1);
  assert.ok(retry);
  retry();
  await flushPromises();
  assert.equal(installs, 1, "the recovered complete snapshot installs once after the failed reads drain");
});

test("sells on the exact 80¢ touch with an IOC ask", async () => {
  install();
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "above_exit_threshold");
  assert.equal(posts.length, 0);
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(result.reason, "full_fill");
  assert.equal(posts.length, 1);
  assert.deepEqual(postCalls, [{ method: "POST", path: "/portfolio/events/orders" }]);
  assert.deepEqual(posts[0], {
    ticker: "KXBTC15M-TEST", client_order_id: records[0]?.id, side: "ask",
    count: "5.00", price: "0.8000", time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  });
  assert.equal(records[0]?.confirmedPositionBefore, 5);
  assert.equal(records[0]?.limitPriceCents, 80);
});

test("uses exact held-side buyers and does not exit immediately while above 80¢", async () => {
  install(); position = -3;
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.5900", "99.00"]], no_dollars: [["0.8100", "3.00"]] },
  }));
  const aboveThreshold = await evaluateProtectiveExit("KXETH15M-TEST");
  assert.equal(aboveThreshold.reason, "above_exit_threshold");
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.5900", "99.00"]], no_dollars: [["0.8000", "3.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXETH15M-TEST");
  assert.equal(result.reason, "full_fill");
  assert.equal(records[0]?.heldSide, "no");
  assert.equal(records[0]?.executableBidCents, 80);
  assert.equal(posts[0]?.count, "3.00");
});

test("paired ETH protects the low held side but holds the high held side through settlement", async () => {
  install();
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] },
  }));

  // A normal pair can have 4 YES at 25¢ and 1 NO at 75¢. The signed exchange
  // position is YES, so the low side must remain eligible for protection.
  position = 3;
  const lowHeld = await evaluateProtectiveExit("KXETH15M-PAIRED", async (_ticker, heldSide) => heldSide === "no");
  assert.equal(lowHeld.reason, "full_fill");
  assert.equal(posts.length, 1, "the paired low held side retains its protective exit");

  // When the exchange-confirmed held side is the 75¢ child, it is exempt.
  position = -1;
  const highHeld = await evaluateProtectiveExit("KXETH15M-PAIRED", async (_ticker, heldSide) => heldSide === "no");
  assert.equal(highHeld.reason, "settlement_hold");
  assert.equal(posts.length, 1, "a paired 70–80¢ leg must remain through settlement");
});

test("sells at any executable price below 80¢ without prior arming, even at 1¢, then fails closed for missing position and audit failure", async () => {
  install();
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [["0.0100", "10.00"]] } }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "full_fill");
  assert.equal(records.at(-1)?.executableBidCents, 1);
  assert.equal(posts.at(-1)?.price, "0.0100");
  position = 0;
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "no_confirmed_position");
  position = 5; persist = false;
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [["0.8100", "10.00"]] } }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "above_exit_threshold");
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] } }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "audit_persistence_failed");
  assert.equal(posts.length, 1, "audit failure must not send a second sell order");
});

test("partial / zero fill retain remaining position and later qualifying liquidity can retry", async () => {
  install();
  let call = 0;
  _setProtectiveExitAuthFetchForTesting((async <T>(_method: string, _path: string, body?: unknown): Promise<T> => {
    call++;
    posts.push(body as Record<string, unknown>);
    const count = String((body as Record<string, unknown>)?.count ?? "0.00");
    return (call === 1
      ? { order: { order_id: "partial", fill_count_fp: "2.00", remaining_count_fp: "3.00" } }
      : { order: { order_id: "rest", fill_count_fp: count, remaining_count_fp: "0.00" } }) as T;
  }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "above_exit_threshold");
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] } }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "partial_fill");
  position = 3;
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "full_fill");
  assert.equal(posts.length, 2);
  assert.equal(records[0]?.remainingPosition, 3);
});

test("YES position uses yes_dollars bids and ignores no_dollars when both sides are populated", async () => {
  // held-side depth (2) is LESS than position (5): count = min(position, held-depth) = 2.
  // If the implementation incorrectly aggregates both sides, depth = 2+99 = 101 → count = 5.
  // Only the correct side selection produces count "2.00".
  install(); // position = 5 (YES)
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: {
      yes_dollars: [["0.8000", "2.00"]],   // 2 contracts — held side, shallower than position
      no_dollars:  [["0.8000", "99.00"]],  // 99 contracts — must be ignored
    },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(result.reason, "full_fill");
  assert.equal(records[0]?.heldSide, "yes");
  assert.equal(records[0]?.executableBidCents, 80);
  assert.equal(posts[0]?.count, "2.00", "count must come from yes_dollars only, not yes+no combined");
  assert.equal(posts.length, 1);
});

test("both sides at exactly 60¢ — only the held-side depth is consumed", async () => {
  // YES sub-case: yes_dollars has 2 contracts, no_dollars has 50 at the same price.
  // position = 5; correct count = min(5, 2) = "2.00"; wrong = min(5, 52) = "5.00".
  install(); // position = 5
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: {
      yes_dollars: [["0.6000", "2.00"]],
      no_dollars:  [["0.6000", "50.00"]], // same price, opposite side — must be ignored
    },
  }));
  const yesResult = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(records[0]?.heldSide, "yes");
  assert.equal(records[0]?.executableBidCents, 60);
  assert.equal(posts[0]?.count, "2.00", "YES exit must consume yes_dollars depth only");

  // NO sub-case: no_dollars has 3 contracts, yes_dollars has 50 at the same price.
  // position abs = 6; correct count = min(6, 3) = "3.00"; wrong = min(6, 53) = "6.00".
  install(); position = -6;
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: {
      yes_dollars: [["0.6000", "50.00"]], // same price, opposite side — must be ignored
      no_dollars:  [["0.6000", "3.00"]],
    },
  }));
  const noResult = await evaluateProtectiveExit("KXETH15M-TEST");
  assert.equal(records[0]?.heldSide, "no");
  assert.equal(records[0]?.executableBidCents, 60);
  assert.equal(posts[0]?.count, "3.00", "NO exit must consume no_dollars depth only");
});

test("duplicate in-flight and transport uncertainty do not cause a second concurrent sell", async () => {
  install(); bookDelay = 25;
  const [one, two] = await Promise.all([
    evaluateProtectiveExit("KXBTC15M-TEST"), evaluateProtectiveExit("KXBTC15M-TEST"),
  ]);
  assert.equal([one.reason, two.reason].includes("exit_in_flight"), true);
  assert.equal(posts.length, 0);
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [["0.6000", "10.00"]] } }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-TEST")).reason, "full_fill");
  assert.equal(posts.length, 1);
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [["0.8100", "10.00"]] } }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-OTHER")).reason, "above_exit_threshold");
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] } }));
  _setProtectiveExitAuthFetchForTesting(async <T>(): Promise<T> => { throw new Error("timeout"); });
  assert.equal((await evaluateProtectiveExit("KXBTC15M-OTHER")).reason, "transport_uncertain");
});

// ── Bypass audit (no POST) ────────────────────────────────────────────────────

test("gap_below_floor: writes audit row when the held-side book is completely empty", async () => {
  install();
  // Empty yes-side book — no buyers at all.
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [] } }));
  const result = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(result.reason, "no_buyer");
  assert.equal(result.attempted, false);
  assert.equal(records.length, 1, "one bypass audit row written");
  assert.equal(records[0]?.outcome, "gap_below_floor");
  assert.equal(records[0]?.reason, "no_buyers_on_held_side");
  assert.equal(records[0]?.postInitiated, false);
  assert.equal(records[0]?.responseReceived, false);
  assert.equal(posts.length, 0, "no order posted");
});

test("gap_below_floor: cooldown suppresses a second write on a repeated tick", async () => {
  install();
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [] } }));
  await evaluateProtectiveExit("KXBTC15M-TEST");
  await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(records.length, 1, "cooldown must suppress the second bypass row");
});

test("gap_below_floor: a different ticker gets its own audit row (cooldown is per-ticker)", async () => {
  install();
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [] } }));
  await evaluateProtectiveExit("KXBTC15M-TEST");
  await evaluateProtectiveExit("KXETH15M-TEST");
  assert.equal(records.length, 2, "each ticker has its own cooldown slot");
  assert.equal(records[0]?.asset, "BTC");
  assert.equal(records[1]?.asset, "ETH");
});

test("gap_below_floor: buyers above 80¢ do not trigger a bypass row", async () => {
  install();
  // Default book has buyers at 81¢ — above_exit_threshold, no bypass row.
  const result = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(result.reason, "above_exit_threshold");
  assert.equal(records.length, 0, "no bypass row when price is above floor");
  assert.equal(posts.length, 0);
});

test("not_armed: writes audit row when system is disabled and book shows price at/below floor", async () => {
  install();
  delete process.env["PROTECTIVE_EXIT_ENABLED"]; // disable
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.7500", "8.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(result.reason, "disabled");
  assert.equal(result.attempted, false);
  assert.equal(records.length, 1, "one not_armed bypass row written");
  assert.equal(records[0]?.outcome, "not_armed");
  assert.equal(records[0]?.executableBidCents, 75);
  assert.equal(records[0]?.postInitiated, false);
  assert.equal(posts.length, 0, "no order posted when disabled");
});

test("not_armed: no audit row when disabled but book shows price above 80¢", async () => {
  install();
  delete process.env["PROTECTIVE_EXIT_ENABLED"];
  // Default book has buyers at 81¢ — above floor, not actionable.
  const result = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(result.reason, "disabled");
  assert.equal(records.length, 0, "no bypass row when price is above floor");
});

test("not_armed: cooldown suppresses repeated rows on consecutive ticks", async () => {
  install();
  delete process.env["PROTECTIVE_EXIT_ENABLED"];
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.7500", "8.00"]] },
  }));
  await evaluateProtectiveExit("KXBTC15M-TEST");
  await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(records.length, 1, "cooldown must suppress the second not_armed row");
});

test("not_armed: book fetch error during disabled check is silently swallowed", async () => {
  install();
  delete process.env["PROTECTIVE_EXIT_ENABLED"];
  _setProtectiveExitBookFetchForTesting(async () => { throw new Error("network failure"); });
  const result = await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(result.reason, "disabled", "must still return disabled, not throw");
  assert.equal(records.length, 0);
});

test("gap_below_floor: cooldown is NOT retained when store returns false; retry succeeds on next tick", async () => {
  install();
  // First call: store returns false (storage unavailable)
  persist = false;
  _setProtectiveExitBookFetchForTesting(async () => ({ orderbook_fp: { yes_dollars: [] } }));
  await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(records.length, 0, "nothing persisted when store returns false");

  // Second call: store recovers — must NOT be blocked by the cooldown
  persist = true;
  await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(records.length, 1, "retry succeeds on the next tick after a failed write");
  assert.equal(records[0]?.outcome, "gap_below_floor");
});

test("not_armed: cooldown is NOT retained when store returns false; retry succeeds on next tick", async () => {
  install();
  delete process.env["PROTECTIVE_EXIT_ENABLED"];
  persist = false;
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.7500", "8.00"]] },
  }));
  await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(records.length, 0, "nothing persisted when store returns false");

  persist = true;
  await evaluateProtectiveExit("KXBTC15M-TEST");
  assert.equal(records.length, 1, "retry succeeds on the next tick after a failed write");
  assert.equal(records[0]?.outcome, "not_armed");
});

test("not_armed: two concurrent disabled evaluations produce exactly one audit row", async () => {
  install();
  delete process.env["PROTECTIVE_EXIT_ENABLED"];
  // Add a small async delay so both calls are genuinely concurrent.
  let bookDelayConcurrent = 10;
  _setProtectiveExitBookFetchForTesting(async () => {
    await new Promise((resolve) => setTimeout(resolve, bookDelayConcurrent));
    return { orderbook_fp: { yes_dollars: [["0.7500", "8.00"]] } };
  });
  const [r1, r2] = await Promise.all([
    evaluateProtectiveExit("KXBTC15M-TEST"),
    evaluateProtectiveExit("KXBTC15M-TEST"),
  ]);
  assert.equal(r1.reason, "disabled");
  assert.equal(r2.reason, "disabled");
  assert.equal(records.length, 1, "in-flight guard must prevent a duplicate not_armed row");
  assert.equal(records[0]?.outcome, "not_armed");
});

// ── Startup restore path ───────────────────────────────────────────────────────

test("restoreArmedPositions populates the restored-tickers set and is cleared by reset", () => {
  restoreArmedPositions(["KXBTC15M-25JAN06", "KXETH15M-25JAN06"]);
  const set = _getRestoredArmedTickersForTesting();
  assert.equal(set.size, 2);
  assert.ok(set.has("KXBTC15M-25JAN06"));
  assert.ok(set.has("KXETH15M-25JAN06"));
  _resetProtectiveExitForTesting();
  assert.equal(_getRestoredArmedTickersForTesting().size, 0);
});

test("restoreArmedPositions with empty list clears any prior entries without error", () => {
  restoreArmedPositions(["KXBTC15M-PREV"]);
  assert.equal(_getRestoredArmedTickersForTesting().size, 1);
  restoreArmedPositions([]);
  assert.equal(_getRestoredArmedTickersForTesting().size, 0);
});

test("an ETH martingale order identity prevents the legacy 80¢ exit from posting", async () => {
  install();
  restoreArmedPositions(
    [],
    [{ ticker: "KXETH15M-MARTINGALE", kalshiOrderId: "martingale-exchange-order-1" }],
  );
  const ownership = _getEthMartingaleOrderIdsByTickerForTesting();
  assert.deepEqual([...ownership.get("KXETH15M-MARTINGALE") ?? []], ["martingale-exchange-order-1"]);
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXETH15M-MARTINGALE");
  assert.equal(result.reason, "eth_martingale_owned");
  assert.equal(posts.length, 0, "legacy 80¢ exit must never submit for a martingale-owned position");
});

test("mixed legacy and ETH martingale ownership is durably surfaced without selling the net position", async () => {
  install(); installIncidents();
  restoreArmedPositions(
    [{ ticker: "KXETH15M-MIXED", side: "yes", quantity: 3 }],
    [{ ticker: "KXETH15M-MIXED", kalshiOrderId: "martingale-exchange-order-2" }],
  );
  assert.ok(_getMixedEthStrategyOwnershipTickersForTesting().has("KXETH15M-MIXED"));
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.6000", "10.00"]] },
  }));

  const result = await evaluateProtectiveExit("KXETH15M-MIXED");
  assert.equal(result.reason, "mixed_eth_strategy_ownership");
  assert.equal(posts.length, 0, "legacy exit must never sell an exchange-net mixed position");
  assert.equal(records.length, 1, "mixed ownership must be visible in durable exit evidence");
  assert.equal(records[0]?.outcome, "mixed_eth_strategy_ownership");
  assert.match(String(records[0]?.reason), /martingale-exchange-order-2/);
  assert.equal(incidents.length, 1, "unresolved mixed ownership requires operator action");
  assert.equal(incidents[0]?.kind, "mixed_eth_strategy_ownership");
  assert.deepEqual(
    getProtectiveExitMonitorStatus().mixedEthStrategyOwnershipTickers,
    ["KXETH15M-MIXED"],
    "the monitor-status response must expose the active ticker for the dashboard alert",
  );
});

test("mixed ETH ownership clears from monitor status only after an authoritative zero position", async () => {
  install();
  restoreArmedPositions(
    [{ ticker: "KXETH15M-MIXED-SETTLED", side: "yes", quantity: 3 }],
    [{ ticker: "KXETH15M-MIXED-SETTLED", kalshiOrderId: "martingale-exchange-order-settled" }],
  );
  assert.ok(getProtectiveExitMonitorStatus().mixedEthStrategyOwnershipTickers.includes("KXETH15M-MIXED-SETTLED"));

  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("transient exchange outage"); });
  assert.equal((await evaluateProtectiveExit("KXETH15M-MIXED-SETTLED")).reason, "position_uncertain");
  assert.ok(
    getProtectiveExitMonitorStatus().mixedEthStrategyOwnershipTickers.includes("KXETH15M-MIXED-SETTLED"),
    "a failed lookup must not clear an unresolved mixed position",
  );

  _setProtectiveExitPositionLookupForTesting(async () => 0);
  assert.equal((await evaluateProtectiveExit("KXETH15M-MIXED-SETTLED")).reason, "no_confirmed_position");
  assert.ok(
    !getProtectiveExitMonitorStatus().mixedEthStrategyOwnershipTickers.includes("KXETH15M-MIXED-SETTLED"),
    "an authoritative zero position clears the active mixed-ownership alert",
  );
});

test("a genuine legacy ETH restore remains eligible for its reduce-only 80¢ exit", async () => {
  install();
  restoreArmedPositions(["KXETH15M-LEGACY"]);
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXETH15M-LEGACY");
  assert.equal(result.reason, "full_fill");
  assert.equal(posts.length, 1);
});

test("exit fires on first 80¢ touch after startup restore, without requiring a prior above-floor tick", async () => {
  install();
  // Simulate what startup restore does: pre-arm the ticker from SQL data.
  restoreArmedPositions(["KXBTC15M-RESTART"]);
  assert.ok(_getRestoredArmedTickersForTesting().has("KXBTC15M-RESTART"));
  // On the very first evaluation the book is exactly at the floor — this
  // should fire immediately without needing an above-floor warm-up tick.
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-RESTART");
  assert.equal(result.reason, "full_fill");
  assert.equal(posts.length, 1);
  assert.equal(records[0]?.confirmedPositionBefore, 5);
  assert.equal(records[0]?.limitPriceCents, 80);
});

test("exit fires on first touch below 80¢ after restart restore, even with a gap down to 1¢", async () => {
  install(); position = 3;
  restoreArmedPositions(["KXBTC15M-GAPDOWN"]);
  // Simulate a gap down well below the floor on first tick after restart.
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.0100", "5.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-GAPDOWN");
  assert.equal(result.reason, "full_fill");
  assert.equal(posts[0]?.price, "0.0100");
  assert.equal(posts[0]?.count, "3.00");
});

test("restore for one ticker does not pre-arm an unrelated ticker", async () => {
  install();
  restoreArmedPositions(["KXBTC15M-ARMED"]);
  // The unrelated ticker still fires normally because there's no arming gate —
  // verify it returns the right reason based on price, not on restore state.
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8100", "10.00"]] },
  }));
  const above = await evaluateProtectiveExit("KXBTC15M-OTHER");
  assert.equal(above.reason, "above_exit_threshold");
  assert.equal(posts.length, 0);
});

// ── Monitor verification-failure evidence & incidents (task 523) ──────────────

import {
  noteConfirmedLocalEntry,
  clearConfirmedLocalEntry,
  _setProtectiveExitIncidentWriterForTesting,
  getProtectiveExitMonitorStatus,
} from "./protectiveExit.js";

type Incident = Record<string, unknown>;
let incidents: Incident[];
function installIncidents(): void {
  incidents = [];
  _setProtectiveExitIncidentWriterForTesting((incident) => {
    incidents.push(incident as unknown as Incident);
  });
}

test("lookup failure for a confirmed local entry writes durable evidence and raises an incident when bid is at/below 80¢", async () => {
  install(); installIncidents();
  noteConfirmedLocalEntry("KXBTC15M-V523", "yes", 107);
  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("kalshi 500"); });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.6200", "50.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-V523");
  assert.equal(result.reason, "position_uncertain");
  assert.equal(posts.length, 0, "must never sell without authoritative confirmation");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, "position_lookup_unavailable");
  assert.equal(records[0]?.executableBidCents, 62);
  assert.equal(records[0]?.confirmedPositionBefore, 107);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.kind, "position_lookup_unavailable");
  assert.equal(incidents[0]?.severity, "high");
  assert.equal(incidents[0]?.localQuantity, 107);
  const status = getProtectiveExitMonitorStatus();
  assert.equal(status.monitorIncidentCount, 1);
  assert.equal((status.lastMonitorIncident as Incident | null)?.["ticker"], "KXBTC15M-V523");
});

test("a transient rate-limit on the initial live position lookup recovers without a stale position or duplicate exit", async () => {
  install(); installIncidents();
  let calls = 0;
  _setProtectiveExitPositionLookupForTesting(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
    return 5;
  });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] },
  }));

  const result = await evaluateProtectiveExit("KXBTC15M-LOOKUP-429");
  assert.equal(result.reason, "full_fill");
  assert.equal(calls, 3, "retry performs one fresh initial read and one pre-POST re-verification");
  assert.equal(posts.length, 1, "a recovered GET permits exactly one normal reduce-only POST");
  assert.equal(records.length, 1);
  assert.equal(incidents.length, 0, "recovered live lookup does not create a false monitor incident");
});

test("exhausted transient lookup retries retain local protection and a later monitor tick can recover once", async () => {
  install(); installIncidents();
  noteConfirmedLocalEntry("KXBTC15M-RETRY-RECOVERY", "yes", 5);
  let calls = 0;
  _setProtectiveExitPositionLookupForTesting(async () => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error("temporary timeout"), { code: "ETIMEDOUT" });
    return 5;
  });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.7500", "10.00"]] },
  }));

  const failed = await evaluateProtectiveExit("KXBTC15M-RETRY-RECOVERY");
  assert.equal(failed.reason, "position_uncertain");
  assert.equal(calls, 2, "one bounded retry is attempted before failing closed");
  assert.equal(posts.length, 0, "no POST uses an uncertain position");
  assert.equal(records[0]?.outcome, "position_lookup_unavailable");
  assert.equal(incidents.length, 1);
  assert.ok(getProtectiveExitMonitorStatus().localConfirmedEntryTickers.includes("KXBTC15M-RETRY-RECOVERY"));

  const recovered = await evaluateProtectiveExit("KXBTC15M-RETRY-RECOVERY");
  assert.equal(recovered.reason, "full_fill");
  assert.equal(posts.length, 1, "recovery on a later tick creates one exit, not a replayed duplicate");
});

test("lookup failure above the floor writes evidence but no incident; repeated ticks are rate-limited", async () => {
  install(); installIncidents();
  noteConfirmedLocalEntry("KXBTC15M-ABOVE", "yes", 10);
  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("timeout"); });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.9000", "50.00"]] },
  }));
  await evaluateProtectiveExit("KXBTC15M-ABOVE");
  await evaluateProtectiveExit("KXBTC15M-ABOVE");
  assert.equal(records.length, 1, "identical evidence rows must be rate-limited");
  assert.equal(records[0]?.outcome, "position_lookup_unavailable");
  assert.equal(incidents.length, 0, "above-floor lookup failure is evidence-only");
});

test("zero exchange position for a known filled entry writes unreconciled evidence and raises an incident when bid ≤ 80¢", async () => {
  install(); installIncidents(); position = 0;
  noteConfirmedLocalEntry("KXBTC15M-ZERO", "yes", 107);
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.4000", "20.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-ZERO");
  assert.equal(result.reason, "no_confirmed_position");
  assert.equal(posts.length, 0);
  assert.equal(records[0]?.outcome, "position_zero_unreconciled");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.kind, "position_zero_unreconciled");
});

test("zero lookup with NO local entry stays silent (no evidence, no incident)", async () => {
  install(); installIncidents(); position = 0;
  const result = await evaluateProtectiveExit("KXBTC15M-NOLOCAL");
  assert.equal(result.reason, "no_confirmed_position");
  assert.equal(records.length, 0);
  assert.equal(incidents.length, 0);
});

test("book unavailable while holding a confirmed position writes evidence and raises an incident", async () => {
  install(); installIncidents();
  _setProtectiveExitBookFetchForTesting(async () => { throw new Error("book 503"); });
  const result = await evaluateProtectiveExit("KXBTC15M-NOBOOK");
  assert.equal(result.reason, "book_unavailable");
  assert.equal(posts.length, 0);
  assert.equal(records[0]?.outcome, "book_unavailable");
  assert.equal(incidents[0]?.kind, "book_unavailable");
});

test("stale book while holding a confirmed position writes evidence and raises an incident", async () => {
  install(); installIncidents(); bookDelay = 2_100;
  const result = await evaluateProtectiveExit("KXBTC15M-STALE");
  assert.equal(result.reason, "book_stale");
  assert.equal(posts.length, 0);
  assert.equal(records[0]?.outcome, "book_stale");
  assert.equal(incidents[0]?.kind, "book_stale");
});

test("lookup failure with unavailable book probe still raises an incident (cannot rule out the floor)", async () => {
  install(); installIncidents();
  noteConfirmedLocalEntry("KXETH15M-BLIND", "no", 12);
  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("down"); });
  _setProtectiveExitBookFetchForTesting(async () => { throw new Error("also down"); });
  const result = await evaluateProtectiveExit("KXETH15M-BLIND");
  assert.equal(result.reason, "position_uncertain");
  assert.equal(records[0]?.outcome, "position_lookup_unavailable");
  assert.ok(String(records[0]?.reason).includes("floor_state=unavailable"));
  assert.equal(incidents.length, 1);
});

test("pre-POST verification failure with an executable bid at/below 80¢ raises an incident and never posts", async () => {
  install(); installIncidents();
  let calls = 0;
  _setProtectiveExitPositionLookupForTesting(async () => {
    calls++;
    if (calls >= 2) throw new Error("prepost outage");
    return 5;
  });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.7500", "10.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-PREPOST");
  assert.equal(result.reason, "position_uncertain_prepost");
  assert.equal(posts.length, 0);
  assert.equal(records[0]?.outcome, "position_lookup_unavailable");
  assert.equal(incidents.length, 1);
});

test("a transient pre-POST position lookup failure retries live state before posting exactly once", async () => {
  install(); installIncidents();
  let calls = 0;
  _setProtectiveExitPositionLookupForTesting(async () => {
    calls++;
    if (calls === 2) throw Object.assign(new Error("provider unavailable"), { status: 503 });
    return 5;
  });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.7500", "10.00"]] },
  }));

  const result = await evaluateProtectiveExit("KXBTC15M-PREPOST-RETRY");
  assert.equal(result.reason, "full_fill");
  assert.equal(calls, 3, "pre-POST retry re-reads the live position after the initial verification");
  assert.equal(posts.length, 1);
  assert.equal(incidents.length, 0);
});

test("restoreArmedPositions registers local confirmed entries so restart survivors keep verification evidence", async () => {
  install(); installIncidents();
  restoreArmedPositions(["KXBTC15M-RESTORED"]);
  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("down after restart"); });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.5000", "10.00"]] },
  }));
  await evaluateProtectiveExit("KXBTC15M-RESTORED");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, "position_lookup_unavailable");
  assert.equal(incidents.length, 1);
});

test("a restored position survives exhausted lookup retries and exits once after the next successful monitor tick", async () => {
  install(); installIncidents();
  restoreArmedPositions([{ ticker: "KXBTC15M-RESTORE-RETRY", side: "yes", quantity: 5 }]);
  let calls = 0;
  _setProtectiveExitPositionLookupForTesting(async () => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error("network timeout"), { code: "ETIMEDOUT" });
    return 5;
  });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.6000", "10.00"]] },
  }));

  assert.equal((await evaluateProtectiveExit("KXBTC15M-RESTORE-RETRY")).reason, "position_uncertain");
  assert.ok(_getRestoredArmedTickersForTesting().has("KXBTC15M-RESTORE-RETRY"));
  assert.equal(posts.length, 0);
  assert.equal((await evaluateProtectiveExit("KXBTC15M-RESTORE-RETRY")).reason, "full_fill");
  assert.equal(posts.length, 1);
});

test("clearConfirmedLocalEntry and a verified full exit stop verification evidence", async () => {
  install(); installIncidents();
  noteConfirmedLocalEntry("KXBTC15M-CLEARED", "yes", 5);
  clearConfirmedLocalEntry("KXBTC15M-CLEARED");
  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("down"); });
  const result = await evaluateProtectiveExit("KXBTC15M-CLEARED");
  assert.equal(result.reason, "position_uncertain");
  assert.equal(records.length, 0);
  assert.equal(incidents.length, 0);
});

test("full exit fill clears the local confirmed entry", async () => {
  install(); installIncidents();
  noteConfirmedLocalEntry("KXBTC15M-EXITED", "yes", 5);
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.8000", "10.00"]] },
  }));
  assert.equal((await evaluateProtectiveExit("KXBTC15M-EXITED")).reason, "full_fill");
  const status = getProtectiveExitMonitorStatus();
  assert.ok(!status.localConfirmedEntryTickers.includes("KXBTC15M-EXITED"));
});

test("restored NO position with unknown side raises an incident when only the NO bid is at/below the floor", async () => {
  install(); installIncidents();
  // Ticker-only restore (side unknown) — must not assume YES.
  restoreArmedPositions(["KXETH15M-NOSIDE"]);
  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("lookup down"); });
  // YES buyers comfortably above the floor; NO buyers gapped to 60¢.
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.9000", "10.00"]], no_dollars: [["0.6000", "10.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXETH15M-NOSIDE");
  assert.equal(result.reason, "position_uncertain");
  assert.equal(posts.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.heldSide, "no", "worst-case side must be recorded, not a YES default");
  assert.equal(records[0]?.executableBidCents, 60);
  assert.ok(String(records[0]?.reason).includes("held_side_unknown_probed_both_books"));
  assert.equal(incidents.length, 1, "NO-side floor breach must raise an incident despite unknown side");
  assert.equal(incidents[0]?.kind, "position_lookup_unavailable");
});

test("restoreArmedPositions with side+quantity entries (startup wiring shape) keeps signed detail for evidence", async () => {
  install(); installIncidents();
  restoreArmedPositions([{ ticker: "KXBTC15M-SIGNED", side: "yes", quantity: 107 }]);
  assert.ok(_getRestoredArmedTickersForTesting().has("KXBTC15M-SIGNED"));
  position = 0; // exchange reports zero for a known 107-contract fill
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.4000", "20.00"]] },
  }));
  const result = await evaluateProtectiveExit("KXBTC15M-SIGNED");
  assert.equal(result.reason, "no_confirmed_position");
  assert.equal(records[0]?.outcome, "position_zero_unreconciled");
  assert.equal(records[0]?.confirmedPositionBefore, 107);
  assert.equal(records[0]?.heldSide, "yes");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.localQuantity, 107);
});

test("unknown side with both books above the floor stays evidence-only (no incident)", async () => {
  install(); installIncidents();
  restoreArmedPositions(["KXBTC15M-BOTHUP"]);
  _setProtectiveExitPositionLookupForTesting(async () => { throw new Error("down"); });
  _setProtectiveExitBookFetchForTesting(async () => ({
    orderbook_fp: { yes_dollars: [["0.9000", "10.00"]], no_dollars: [["0.8500", "10.00"]] },
  }));
  await evaluateProtectiveExit("KXBTC15M-BOTHUP");
  assert.equal(records.length, 1);
  assert.equal(incidents.length, 0);
});
