import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRefreshCoordinator } from "./refreshCoordinator.js";

describe("portfolio refresh coordinator", () => {
  it("joins overlapping refresh triggers and releases after completion", async () => {
    const coordinator = createRefreshCoordinator();
    let calls = 0;
    let resolveRefresh: (() => void) | undefined;
    const refresh = () => {
      calls++;
      return new Promise<void>((resolve) => { resolveRefresh = resolve; });
    };

    const first = coordinator.run(refresh);
    const second = coordinator.run(refresh);
    assert.equal(calls, 1);
    assert.equal(first, second);

    resolveRefresh?.();
    await first;
    await coordinator.run(async () => { calls++; });
    assert.equal(calls, 2);
  });
});