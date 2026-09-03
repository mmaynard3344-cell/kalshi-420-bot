/**
 * Deterministic tests for the reporting-only Kalshi daily P&L calculation.
 * No test issues a real authenticated request or writes an order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_PROFIT_TARGET_DOLLARS,
  _resetDailyProfitStopForTesting,
  _setDailyProfitStopAuditSinkForTesting,
  _setDailyProfitStopFetchForTesting,
  allowNewInvestment,
  getDailyProfitStopStatus,
} from "./dailyProfitStop.js";
import { isRetryableKalshiReadStatus } from "./kalshiAuth.js";

// Use the real current time so the synthetic fill always lands on "today's"
// Eastern trading day — a hardcoded date breaks the suite at the next
// calendar rollover, since the guard filters fills to the current day.
const NOW = new Date();
const TODAY_FILL = {
  ticker: "KXBTC15M-TEST",
  side: "yes",
  yes_price_dollars: "0.2500",
  count_fp: "100",
  fee_cost: "0.01",
  created_time: NOW.toISOString(),
};

function install(pnl: number): void {
  // A YES winner at 25c produces 75c gross per contract. Construct exact
  // whole-dollar P&L by adjusting the fee on a 100-contract test fill.
  const fill = { ...TODAY_FILL, fee_cost: String(75 - pnl) };
  _setDailyProfitStopFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/fills?")) return { fills: [fill] } as T;
    if (path === `/markets/${fill.ticker}`) return { market: { result: "yes" } } as T;
    throw new Error(`unexpected path ${path}`);
  });
}

test.afterEach(() => _resetDailyProfitStopForTesting());

test("does not make daily P&L an entry gate", async () => {
  install(74.99);
  const result = await allowNewInvestment("KXBTC15M-TEST");
  assert.equal(DAILY_PROFIT_TARGET_DOLLARS, null);
  assert.equal(result.allowed, true);
  assert.equal(result.status.state, "disabled");
  assert.equal(result.status.realizedPnlDollars, null);
});

test("permits an entry even after a formerly blocking profit amount", async () => {
  const audits: Array<{ kind: string; ticker: string | null }> = [];
  _setDailyProfitStopAuditSinkForTesting((audit) => audits.push(audit));
  install(75);
  const exactly = await allowNewInvestment("KXBTC15M-TEST");
  assert.equal(exactly.allowed, true);
  assert.equal(exactly.status.state, "disabled");

  install(75.01);
  const above = await allowNewInvestment("KXETH15M-TEST");
  assert.equal(above.allowed, true);
  assert.equal(above.status.state, "disabled");
  assert.deepEqual(audits, []);
});

test("reports unavailable history without blocking entries", async () => {
  _setDailyProfitStopAuditSinkForTesting(() => {});
  _setDailyProfitStopFetchForTesting(async <T>(): Promise<T> => ({}) as T);
  assert.equal((await getDailyProfitStopStatus()).state, "unavailable");

  _setDailyProfitStopFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/fills?")) return { fills: [{ ...TODAY_FILL, count_fp: "bad" }] } as T;
    return { market: { result: "yes" } } as T;
  });
  assert.equal((await getDailyProfitStopStatus()).state, "unavailable");

  _setDailyProfitStopFetchForTesting(async (): Promise<never> => {
    throw new Error("Kalshi unavailable");
  });
  const unavailable = await getDailyProfitStopStatus();
  assert.equal(unavailable.state, "unavailable");
  const entry = await allowNewInvestment();
  assert.equal(entry.allowed, true);
  assert.equal(entry.status.state, "disabled");
});

test("uses the Eastern day, including both DST midnight boundaries", async () => {
  install(0);
  const beforeSpring = await getDailyProfitStopStatus(new Date("2025-03-10T03:59:59.999Z"));
  const afterSpring = await getDailyProfitStopStatus(new Date("2025-03-10T04:00:00.000Z"));
  assert.equal(beforeSpring.easternDate, "2025-03-09");
  assert.equal(beforeSpring.state, "disabled");
  assert.equal(afterSpring.easternDate, "2025-03-10");
  assert.equal(afterSpring.state, "disabled");

  const beforeFall = await getDailyProfitStopStatus(new Date("2025-11-03T04:59:59.999Z"));
  const afterFall = await getDailyProfitStopStatus(new Date("2025-11-03T05:00:00.000Z"));
  assert.equal(beforeFall.easternDate, "2025-11-02");
  assert.equal(beforeFall.state, "disabled");
  assert.equal(afterFall.easternDate, "2025-11-03");
  assert.equal(afterFall.state, "disabled");
});

test("rate limits and transient server errors are retryable reads; other HTTP statuses are definitive", () => {
  assert.equal(isRetryableKalshiReadStatus(429), true);
  assert.equal(isRetryableKalshiReadStatus(500), true);
  assert.equal(isRetryableKalshiReadStatus(503), true);
  for (const definitive of [400, 401, 403, 404, 410]) {
    assert.equal(isRetryableKalshiReadStatus(definitive), false);
  }
  assert.equal(isRetryableKalshiReadStatus(undefined), false);
});

test("an HTTP 429 is reported but cannot block entry when the target is disabled", async () => {
  const audits: Array<{ kind: string; status: { state: string; reason?: string } }> = [];
  _setDailyProfitStopAuditSinkForTesting((audit) => audits.push(audit));
  _setDailyProfitStopFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/fills?")) return { fills: [TODAY_FILL] } as T;
    throw Object.assign(new Error("Kalshi auth API error 429"), { status: 429 });
  });
  const report = await getDailyProfitStopStatus();
  assert.equal(report.state, "unavailable");
  assert.match(report.reason ?? "", /429/);
  const entry = await allowNewInvestment("KXETH15M-TEST");
  assert.equal(entry.allowed, true);
  assert.equal(entry.status.state, "disabled");
  assert.deepEqual(audits, []);
});

test("resolves each distinct ticker once per run and caches resolved results across runs", async () => {
  const marketCalls: string[] = [];
  const fills = [
    { ...TODAY_FILL, ticker: "KXETH15M-A" },
    { ...TODAY_FILL, ticker: "KXETH15M-A" },
    { ...TODAY_FILL, ticker: "KXETH15M-A" },
    { ...TODAY_FILL, ticker: "KXSOL15M-B" },
  ];
  _setDailyProfitStopFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/fills?")) return { fills } as T;
    marketCalls.push(path);
    return { market: { result: "no" } } as T;
  });
  const first = await getDailyProfitStopStatus();
  assert.equal(first.state, "disabled");
  // 4 same-day fills over 2 distinct tickers → exactly 2 market lookups.
  assert.deepEqual([...marketCalls].sort(), ["/markets/KXETH15M-A", "/markets/KXSOL15M-B"]);
  marketCalls.length = 0;
  const second = await getDailyProfitStopStatus();
  assert.equal(second.state, "disabled");
  // Resolved market results never change → no repeat lookups on later runs.
  assert.deepEqual(marketCalls, []);
});

test("an unresolved market is re-checked on the next run (never cached)", async () => {
  const marketCalls: string[] = [];
  let resolved = false;
  _setDailyProfitStopFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/fills?")) return { fills: [TODAY_FILL] } as T;
    marketCalls.push(path);
    return { market: resolved ? { result: "yes" } : {} } as T;
  });
  const pending = await getDailyProfitStopStatus();
  assert.equal(pending.state, "disabled");
  assert.equal(pending.realizedPnlDollars, 0); // unresolved contributes nothing
  resolved = true;
  const after = await getDailyProfitStopStatus();
  assert.equal(after.state, "disabled");
  assert.equal(after.realizedPnlDollars, 74.99);
  assert.equal(marketCalls.length, 2);
});

test("concurrent callers share a single in-flight exchange run", async () => {
  let fillsFetches = 0;
  _setDailyProfitStopFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/fills?")) {
      fillsFetches++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { fills: [TODAY_FILL] } as T;
    }
    return { market: { result: "yes" } } as T;
  });
  const [a, b, c] = await Promise.all([
    getDailyProfitStopStatus(), getDailyProfitStopStatus(), getDailyProfitStopStatus(),
  ]);
  assert.equal(fillsFetches, 1);
  assert.deepEqual([a.state, b.state, c.state], ["disabled", "disabled", "disabled"]);
});

test("a post-midnight caller never shares a pre-midnight in-flight run", async () => {
  // Two fixed instants on opposite sides of an Eastern midnight (05:00 UTC in
  // winter). The fill lands on the pre-midnight day, so the old-day run sees
  // realized P&L while the new-day run must see none.
  const beforeMidnight = new Date("2025-11-04T04:59:00.000Z"); // 2025-11-03 ET
  const afterMidnight = new Date("2025-11-04T05:01:00.000Z"); // 2025-11-04 ET
  let releaseFirstFills: (() => void) | null = null;
  let fillsFetches = 0;
  _setDailyProfitStopFetchForTesting(async <T>(_method: string, path: string): Promise<T> => {
    if (path.startsWith("/portfolio/fills?")) {
      fillsFetches++;
      if (fillsFetches === 1) await new Promise<void>((resolve) => { releaseFirstFills = resolve; });
      return { fills: [{ ...TODAY_FILL, created_time: beforeMidnight.toISOString() }] } as T;
    }
    return { market: { result: "yes" } } as T;
  });
  const oldDayPromise = getDailyProfitStopStatus(beforeMidnight);
  await new Promise((resolve) => setImmediate(resolve)); // first run now holds the flight
  const newDayPromise = getDailyProfitStopStatus(afterMidnight);
  releaseFirstFills!();
  const [oldDay, newDay] = await Promise.all([oldDayPromise, newDayPromise]);
  assert.equal(fillsFetches, 2, "post-midnight caller must run its own exchange fetch");
  assert.equal(oldDay.easternDate, "2025-11-03");
  assert.equal(oldDay.realizedPnlDollars, 74.99);
  assert.equal(newDay.easternDate, "2025-11-04");
  assert.equal(newDay.realizedPnlDollars, 0); // prior-day fill excluded from the new day
});

test("concurrent entries remain permitted when the target is disabled", async () => {
  _setDailyProfitStopAuditSinkForTesting(() => {});
  install(75);
  const results = await Promise.all([
    allowNewInvestment("KXBTC15M-A"),
    allowNewInvestment("KXBTC15M-B"),
    allowNewInvestment("KXETH15M-A"),
  ]);
  assert.deepEqual(results.map((result) => result.allowed), [true, true, true]);
  assert.deepEqual(results.map((result) => result.status.state), ["disabled", "disabled", "disabled"]);
});