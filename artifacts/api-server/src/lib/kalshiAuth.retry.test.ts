import assert from "node:assert/strict";
import test from "node:test";
import {
  kalshiAuthFetch,
  setKalshiReadNetworkEventSink,
  _resetAuthenticatedReadSchedulerForTesting,
  type KalshiReadNetworkEvent,
} from "./kalshiAuth.js";

test("bounds ordinary authenticated GETs to leave a safety slot free", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximumActive = 0;
  _resetAuthenticatedReadSchedulerForTesting();
  globalThis.fetch = (async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return new Response(JSON.stringify({ market: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      kalshiAuthFetch("GET", `/markets/shared-budget-${index}`),
    ));
    assert.equal(maximumActive, 1, "ordinary callers must leave one account-wide slot for safety checks");
  } finally {
    globalThis.fetch = originalFetch;
    _resetAuthenticatedReadSchedulerForTesting();
  }
});

test("a protective safety GET uses the reserved slot ahead of queued normal reads", async () => {
  const originalFetch = globalThis.fetch;
  let releaseFirstNormal: (() => void) | undefined;
  let firstNormalStarted = false;
  let safetyStarted = false;
  _resetAuthenticatedReadSchedulerForTesting();
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("normal-first")) {
      firstNormalStarted = true;
      await new Promise<void>((resolve) => { releaseFirstNormal = resolve; });
    }
    if (url.includes("/portfolio/positions")) safetyStarted = true;
    return new Response(JSON.stringify({ market: {}, market_positions: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = kalshiAuthFetch("GET", "/markets/normal-first");
    const queuedNormal = kalshiAuthFetch("GET", "/markets/normal-second");
    while (!firstNormalStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    const safety = kalshiAuthFetch("GET", "/portfolio/positions?ticker=KXETH15M", undefined, {
      readPriority: "safety",
    });
    while (!safetyStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    releaseFirstNormal?.();
    await Promise.all([first, queuedNormal, safety]);
    assert.equal(safetyStarted, true);
  } finally {
    globalThis.fetch = originalFetch;
    _resetAuthenticatedReadSchedulerForTesting();
  }
});

test("honors Retry-After before retrying an authenticated GET", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  _resetAuthenticatedReadSchedulerForTesting();
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "retry-after": "0.05" },
      });
    }
    return new Response(JSON.stringify({ market: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const startedAt = Date.now();
    await kalshiAuthFetch("GET", "/markets/retry-after");
    assert.equal(calls, 2);
    assert.ok(Date.now() - startedAt >= 40, "retry must wait for the server cooldown");
  } finally {
    globalThis.fetch = originalFetch;
    _resetAuthenticatedReadSchedulerForTesting();
  }
});

test("retries a transient authenticated GET and records recovery", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const events: KalshiReadNetworkEvent[] = [];
  setKalshiReadNetworkEventSink((event) => events.push(event));
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("socket disconnected");
    return new Response(JSON.stringify({ market: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    await kalshiAuthFetch("GET", "/markets/test");
    assert.equal(calls, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.recoveryOutcome, "recovered");
    assert.equal(events[0]?.retryCount, 1);
    assert.equal(events[0]?.endpointCategory, "market_result");
  } finally {
    globalThis.fetch = originalFetch;
    setKalshiReadNetworkEventSink(null);
  }
});

test("never retries an authenticated order POST", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let capturedBody: string | undefined;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    calls++;
    capturedBody = init?.body as string | undefined;
    throw new TypeError("socket disconnected");
  }) as typeof fetch;
  try {
    await assert.rejects(() => kalshiAuthFetch("POST", "/portfolio/orders", { ticker: "test-ticker", count: 1 }));
    assert.equal(calls, 1);
    assert.equal(capturedBody, JSON.stringify({ ticker: "test-ticker", count: 1 }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves complete manual, AutoTrader, and protective-exit order bodies verbatim", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<{ url: string; body: string | undefined }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    sent.push({ url: String(input), body: init?.body as string | undefined });
    return new Response(JSON.stringify({ order: {} }), { status: 200 });
  }) as typeof fetch;
  const bodies = [
    {
      ticker: "KXBTC15M-MANUAL", client_order_id: "manual-client-id", side: "bid",
      count: "111.00", price: "0.9000", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross",
    },
    {
      ticker: "KXBTC15M-AUTO", client_order_id: "auto-client-id", side: "ask",
      count: "111.00", price: "0.1000", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross",
    },
    {
      ticker: "KXETH15M-EXIT", client_order_id: "exit-client-id", side: "ask",
      count: "5.00", price: "0.8000", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross",
    },
  ];
  try {
    for (const body of bodies) await kalshiAuthFetch("POST", "/portfolio/events/orders", body);
    assert.equal(sent.length, 3, "POST requests must remain single-attempt");
    assert.deepEqual(sent.map((entry) => JSON.parse(entry.body ?? "")), bodies);
    assert.ok(sent.every((entry) => entry.url.endsWith("/portfolio/events/orders")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("records zero retries for a definitive GET response failure", async () => {
  const originalFetch = globalThis.fetch;
  const events: KalshiReadNetworkEvent[] = [];
  let calls = 0;
  setKalshiReadNetworkEventSink((event) => events.push(event));
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => kalshiAuthFetch("GET", "/markets/missing"));
    assert.equal(calls, 1);
    assert.equal(events[0]?.retryCount, 0);
    assert.equal(events[0]?.recoveryOutcome, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    setKalshiReadNetworkEventSink(null);
  }
});

test("records every retry when a GET transport failure is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const events: KalshiReadNetworkEvent[] = [];
  let calls = 0;
  setKalshiReadNetworkEventSink((event) => events.push(event));
  globalThis.fetch = (async () => {
    calls++;
    throw new TypeError("socket disconnected");
  }) as typeof fetch;
  try {
    await assert.rejects(() => kalshiAuthFetch("GET", "/markets/unreachable"));
    assert.equal(calls, 4);
    assert.equal(events[0]?.retryCount, 3);
    assert.equal(events[0]?.recoveryOutcome, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    setKalshiReadNetworkEventSink(null);
  }
});

test("retries a rate-limited GET (429) and recovers", async () => {
  const originalFetch = globalThis.fetch;
  const events: KalshiReadNetworkEvent[] = [];
  let calls = 0;
  setKalshiReadNetworkEventSink((event) => events.push(event));
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    return new Response(JSON.stringify({ market: { result: "yes" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await kalshiAuthFetch<{ market: { result: string } }>("GET", "/markets/rate-limited");
    assert.equal(result.market.result, "yes");
    assert.equal(calls, 2);
    assert.equal(events[0]?.recoveryOutcome, "recovered");
    assert.equal(events[0]?.retryCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    setKalshiReadNetworkEventSink(null);
  }
});

test("retries a transient 5xx GET and recovers", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= 2) return new Response("bad gateway", { status: 502 });
    return new Response(JSON.stringify({ fills: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await kalshiAuthFetch<{ fills: unknown[] }>("GET", "/portfolio/fills?limit=1000");
    assert.deepEqual(result.fills, []);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an exhausted 429 GET fails with a named HTTP error class in telemetry", async () => {
  const originalFetch = globalThis.fetch;
  const events: KalshiReadNetworkEvent[] = [];
  let calls = 0;
  setKalshiReadNetworkEventSink((event) => events.push(event));
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => kalshiAuthFetch("GET", "/markets/always-rate-limited"),
      (err: Error & { status?: number }) => err.status === 429 && err.name === "KalshiHttp429",
    );
    assert.equal(calls, 4); // initial + 3 bounded retries
    assert.equal(events[0]?.recoveryOutcome, "failed");
    assert.equal(events[0]?.retryCount, 3);
    assert.equal(events[0]?.errorClass, "KalshiHttp429");
  } finally {
    globalThis.fetch = originalFetch;
    setKalshiReadNetworkEventSink(null);
  }
});

test("a rate-limited POST is never retried (writes are not idempotent)", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => kalshiAuthFetch("POST", "/portfolio/events/orders", { ticker: "t" }));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});