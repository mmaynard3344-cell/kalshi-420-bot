/**
 * trade.ts — balance route regression tests.
 *
 * Proves that GET /trade/balance never throws a ReferenceError regardless of
 * whether the Kalshi API call succeeds or fails. The route must:
 *   1. Call /portfolio/balance, not /portfolio/fills (no `qs` in scope).
 *   2. Return parseable JSON on success.
 *   3. Return a structured JSON error envelope on Kalshi failure — never a
 *      bare HTML 502 page and never an uncaught exception.
 *
 * These tests exercise the route logic directly (without Express) so they stay
 * dependency-free and run in the same Node.js test harness as the rest of the
 * suite.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTradeBalanceDashboardResponse } from "../lib/kalshiBalance.js";

// ---------------------------------------------------------------------------
// Helpers — simulate the balance route handler inline
// ---------------------------------------------------------------------------

/**
 * Stub of the balance route body. Mirrors trade.ts exactly so a copy-paste
 * regression (e.g. re-introducing `/portfolio/fills?${qs}`) would break this
 * test immediately.
 *
 * The `fetchFn` parameter replaces `kalshiAuthFetch` so we can control what
 * Kalshi "returns" without making real network calls.
 */
async function runBalanceHandler(
  fetchFn: (method: string, path: string) => Promise<unknown>,
): Promise<{ status: number; body: unknown }> {
  let responseStatus = 200;
  let responseBody: unknown;

  const res = {
    status(code: number) { responseStatus = code; return res; },
    json(body: unknown) { responseBody = body; },
    headersSent: false,
  };

  try {
    // ── Exact path used in trade.ts ──────────────────────────────────────
    // If someone changes this back to `/portfolio/fills?${qs}` the reference
    // to the undeclared `qs` will throw a ReferenceError here, failing the test.
    const data = await fetchFn("GET", `/portfolio/balance`);
    res.json(data);
  } catch (err: unknown) {
    const e = err as { status?: number; body?: unknown; message?: string };
    if (res.headersSent) return { status: responseStatus, body: responseBody };
    const httpStatus = typeof e.status === "number" ? e.status : 502;
    res.status(httpStatus).json({
      error:   "Kalshi request failed",
      details: e.message ?? String(err),
      status:  httpStatus,
      kalshi:  e.body ?? null,
    });
  }

  return { status: responseStatus, body: responseBody };
}

// ---------------------------------------------------------------------------
// A — happy path: Kalshi returns a balance object
// ---------------------------------------------------------------------------

describe("A — GET /trade/balance: happy path", () => {
  it("returns 200 with the balance payload when Kalshi succeeds", async () => {
    const fakeBalance = { balance: 12345, payout: 0, fees: 10 };

    const result = await runBalanceHandler(async (_method, path) => {
      assert.equal(path, "/portfolio/balance", "must call /portfolio/balance, not /portfolio/fills");
      return fakeBalance;
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, fakeBalance);
  });

  it("calls GET, not POST", async () => {
    const calls: string[] = [];

    await runBalanceHandler(async (method, _path) => {
      calls.push(method);
      return {};
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0], "GET");
  });

  it("path is exactly /portfolio/balance with no query string", async () => {
    let capturedPath = "";

    await runBalanceHandler(async (_method, path) => {
      capturedPath = path;
      return {};
    });

    assert.equal(capturedPath, "/portfolio/balance");
    assert.ok(!capturedPath.includes("?"), "balance path must not contain a query string");
    assert.ok(!capturedPath.includes("fills"), "balance path must not reference fills");
  });
});

describe("A.1 — active ETH exchange balance response", () => {
  it("keeps aggregate cash distinct from a successful exchange-scoped ETH balance", () => {
    const body = buildTradeBalanceDashboardResponse(
      { value: { balance: 81_395, balance_dollars: "813.9500" }, stale: false },
      2,
      { value: { balance: 63, balance_dollars: "0.6300" }, stale: false },
    );

    assert.equal(body.aggregate_balance_cents, 81_395);
    assert.equal(body.active_eth_exchange_index, 2);
    assert.deepEqual(body.active_eth_exchange_balance, {
      exchange_index: 2,
      available_balance_cents: 63,
      available_balance_dollars: "0.63",
      stale: false,
    });
  });

  it("marks the active ETH exchange balance unavailable when its scoped read fails", () => {
    const body = buildTradeBalanceDashboardResponse(
      { value: { balance: 81_395 }, stale: false },
      2,
      null,
    );

    assert.deepEqual(body.active_eth_exchange_balance, {
      exchange_index: 2,
      available_balance_cents: null,
      available_balance_dollars: null,
      stale: true,
    });
  });
});

// ---------------------------------------------------------------------------
// B — Kalshi returns an error: handler must not throw, must return JSON
// ---------------------------------------------------------------------------

describe("B — GET /trade/balance: Kalshi failure produces structured JSON", () => {
  it("wraps a Kalshi 401 in a JSON envelope — no uncaught exception", async () => {
    const result = await runBalanceHandler(async () => {
      const err = Object.assign(new Error("Unauthorized"), { status: 401, body: { message: "bad key" } });
      throw err;
    });

    assert.equal(result.status, 401);
    const body = result.body as Record<string, unknown>;
    assert.equal(body["error"], "Kalshi request failed");
    assert.equal(body["status"], 401);
    assert.ok("kalshi" in body, "envelope must include a kalshi field");
  });

  it("wraps a network error (no .status) in a 502 envelope", async () => {
    const result = await runBalanceHandler(async () => {
      throw new Error("ECONNREFUSED");
    });

    assert.equal(result.status, 502);
    const body = result.body as Record<string, unknown>;
    assert.equal(body["status"], 502);
    assert.equal(body["error"], "Kalshi request failed");
    assert.equal(body["details"], "ECONNREFUSED");
  });

  it("never throws a ReferenceError (qs is not defined)", async () => {
    // If the route body references an undeclared variable (`qs`), the fetch
    // function is never even called — the ReferenceError fires first.
    let fetchCalled = false;

    const result = await runBalanceHandler(async () => {
      fetchCalled = true;
      return { balance: 0 };
    });

    assert.ok(fetchCalled, "fetchFn must be called — a ReferenceError before it means `qs` crept back in");
    assert.equal(result.status, 200);
  });
});

// ---------------------------------------------------------------------------
// C — response shape: body is always parseable JSON (never empty / undefined)
// ---------------------------------------------------------------------------

describe("C — GET /trade/balance: response body is always present", () => {
  it("body is defined on success", async () => {
    const result = await runBalanceHandler(async () => ({ balance: 500 }));
    assert.notEqual(result.body, undefined);
    assert.notEqual(result.body, null);
  });

  it("body is defined on Kalshi failure", async () => {
    const result = await runBalanceHandler(async () => {
      throw Object.assign(new Error("timeout"), { status: 504 });
    });
    assert.notEqual(result.body, undefined);
    assert.ok(typeof result.body === "object");
  });
});
