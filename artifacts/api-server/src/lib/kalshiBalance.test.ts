import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSuccessOnlySingleFlightCache } from "./kalshiBalance.js";

describe("success-only balance cache", () => {
  it("shares concurrent loads and reuses a recent successful value", async () => {
    let calls = 0;
    let resolveLoad: ((value: { balance: number }) => void) | undefined;
    const cache = createSuccessOnlySingleFlightCache<{ balance: number }>(10_000);
    const load = () => {
      calls++;
      return new Promise<{ balance: number }>((resolve) => { resolveLoad = resolve; });
    };

    const first = cache.get(load);
    const second = cache.get(load);
    assert.equal(calls, 1);
    assert.equal(first, second);

    resolveLoad?.({ balance: 123 });
    assert.deepEqual(await first, { balance: 123 });
    assert.deepEqual(await cache.get(load), { balance: 123 });
    assert.equal(calls, 1);
  });

  it("does not cache a failed request", async () => {
    let calls = 0;
    const cache = createSuccessOnlySingleFlightCache<{ balance: number }>(10_000);

    await assert.rejects(cache.get(async () => {
      calls++;
      throw new Error("429");
    }));
    assert.deepEqual(await cache.get(async () => {
      calls++;
      return { balance: 456 };
    }), { balance: 456 });
    assert.equal(calls, 2);
  });
});