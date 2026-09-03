import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createKeyedQuotaAwareCache,
  createQuotaAwareCache,
  createRateLimitGate,
  RATE_LIMIT_COOLDOWN_MS,
} from "./kalshiAccountReads.js";

function rateLimitError(): Error {
  return Object.assign(new Error("Kalshi auth API error 429"), { status: 429 });
}

describe("quota-aware account read cache", () => {
  it("coalesces concurrent callers into one upstream request", async () => {
    let calls = 0;
    let resolveLoad: ((v: { n: number }) => void) | undefined;
    const cache = createQuotaAwareCache<{ n: number }>({ ttlMs: 10_000, gate: createRateLimitGate() });
    const load = () => {
      calls++;
      return new Promise<{ n: number }>((resolve) => { resolveLoad = resolve; });
    };

    const first = cache.get(load);
    const second = cache.get(load);
    assert.equal(calls, 1);
    assert.equal(first, second);

    resolveLoad?.({ n: 1 });
    assert.deepEqual(await first, { value: { n: 1 }, stale: false });
  });

  it("reuses a fresh value for the TTL, then refetches", async () => {
    let calls = 0;
    let clock = 0;
    const cache = createQuotaAwareCache<number>({ ttlMs: 15_000, gate: createRateLimitGate(() => clock), now: () => clock });
    const load = async () => ++calls;

    assert.deepEqual(await cache.get(load), { value: 1, stale: false });
    clock += 14_999;
    assert.deepEqual(await cache.get(load), { value: 1, stale: false });
    assert.equal(calls, 1);
    clock += 2;
    assert.deepEqual(await cache.get(load), { value: 2, stale: false });
    assert.equal(calls, 2);
  });

  it("serves the last known value marked stale on a 429 and blocks retries during the cooldown", async () => {
    let calls = 0;
    let clock = 0;
    const gate = createRateLimitGate(() => clock);
    const cache = createQuotaAwareCache<number>({ ttlMs: 1_000, gate, now: () => clock });

    assert.deepEqual(await cache.get(async () => { calls++; return 7; }), { value: 7, stale: false });

    clock += 2_000; // fresh TTL expired
    const rateLimited = async (): Promise<number> => { calls++; throw rateLimitError(); };
    assert.deepEqual(await cache.get(rateLimited), { value: 7, stale: true });
    assert.equal(calls, 2);

    // During the cooldown, no upstream call is made at all — no retry burst.
    clock += 1;
    assert.deepEqual(await cache.get(rateLimited), { value: 7, stale: true });
    clock += RATE_LIMIT_COOLDOWN_MS - 2;
    assert.deepEqual(await cache.get(rateLimited), { value: 7, stale: true });
    assert.equal(calls, 2);

    // After the cooldown, a real refetch happens again.
    clock += 2;
    assert.deepEqual(await cache.get(async () => { calls++; return 8; }), { value: 8, stale: false });
    assert.equal(calls, 3);
  });

  it("rejects with a 429 error when rate limited and no cached value exists", async () => {
    let clock = 0;
    const gate = createRateLimitGate(() => clock);
    const cache = createQuotaAwareCache<number>({ ttlMs: 1_000, gate, now: () => clock });

    await assert.rejects(cache.get(async () => { throw rateLimitError(); }), (err: { status?: number }) => err.status === 429);
    // Gate is now closed and there is still no cached value.
    await assert.rejects(cache.get(async () => 1), (err: { status?: number }) => err.status === 429);
    // No upstream call happened during the cooldown; it recovers afterwards.
    clock += RATE_LIMIT_COOLDOWN_MS + 1;
    assert.deepEqual(await cache.get(async () => 1), { value: 1, stale: false });
  });

  it("serves stale data on transient non-429 failures without tripping the gate", async () => {
    let clock = 0;
    const gate = createRateLimitGate(() => clock);
    const cache = createQuotaAwareCache<number>({ ttlMs: 1_000, gate, now: () => clock });

    assert.deepEqual(await cache.get(async () => 5), { value: 5, stale: false });
    clock += 2_000;
    assert.deepEqual(await cache.get(async () => { throw new Error("socket hang up"); }), { value: 5, stale: true });
    assert.equal(gate.isBlocked(), false);
    // Next call retries upstream immediately (no cooldown for non-429).
    assert.deepEqual(await cache.get(async () => 6), { value: 6, stale: false });
  });

  it("propagates non-429 failures when there is no cached value", async () => {
    const cache = createQuotaAwareCache<number>({ ttlMs: 1_000, gate: createRateLimitGate() });
    await assert.rejects(cache.get(async () => { throw new Error("boom"); }), /boom/);
    // Failure is not cached; the next attempt goes upstream.
    assert.deepEqual(await cache.get(async () => 3), { value: 3, stale: false });
  });

  it("shares one rate-limit gate across balance, positions, and fills caches", async () => {
    let clock = 0;
    const gate = createRateLimitGate(() => clock);
    const positions = createQuotaAwareCache<string>({ ttlMs: 1_000, gate, now: () => clock });
    const balance = createQuotaAwareCache<string>({ ttlMs: 1_000, gate, now: () => clock });

    assert.deepEqual(await balance.get(async () => "bal"), { value: "bal", stale: false });
    clock += 2_000;

    // Positions read hits a 429 → the shared gate closes for balance too.
    await assert.rejects(positions.get(async () => { throw rateLimitError(); }));
    let balanceCalls = 0;
    assert.deepEqual(await balance.get(async () => { balanceCalls++; return "new"; }), { value: "bal", stale: true });
    assert.equal(balanceCalls, 0);
  });

  it("keyed fills cache coalesces per key and shares the gate", async () => {
    let clock = 0;
    const gate = createRateLimitGate(() => clock);
    const keyed = createKeyedQuotaAwareCache<string>({ ttlMs: 1_000, gate, now: () => clock });

    let calls = 0;
    const [a, b] = await Promise.all([
      keyed.get("limit=100", async () => { calls++; return "page"; }),
      keyed.get("limit=100", async () => { calls++; return "page"; }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(a, { value: "page", stale: false });
    assert.deepEqual(b, { value: "page", stale: false });

    // A different key loads independently…
    assert.deepEqual(await keyed.get("limit=25", async () => "small"), { value: "small", stale: false });

    // …but a 429 on one key blocks upstream calls for every key.
    clock += 2_000;
    assert.deepEqual(await keyed.get("limit=100", async () => { throw rateLimitError(); }), { value: "page", stale: true });
    let smallCalls = 0;
    assert.deepEqual(await keyed.get("limit=25", async () => { smallCalls++; return "x"; }), { value: "small", stale: true });
    assert.equal(smallCalls, 0);
  });
});
