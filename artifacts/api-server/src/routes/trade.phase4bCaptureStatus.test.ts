import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";

process.env["TRADE_API_TOKEN"] = "phase4b-status-test-token";
delete process.env["VITE_TRADE_API_TOKEN"];

const { default: tradeRouter } = await import("./trade.js");

async function withServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(tradeRouter);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("GET /trade/phase4b-capture/status requires trade auth and exposes only safe, read-only metrics", async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/trade/phase4b-capture/status`);
    assert.equal(unauthorized.status, 401);

    const options = { headers: { "X-Trade-Token": "phase4b-status-test-token" } };
    const first = await fetch(`${baseUrl}/trade/phase4b-capture/status`, options);
    assert.equal(first.status, 200);
    const firstStatus = await first.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(firstStatus).sort(), [
      "enabled",
      "referenceHistoryCorruptReloads",
      "enqueueAttempts",
      "successfulWrites",
      "failedWrites",
      "queueDrops",
      "mostRecentEnqueueAt",
      "mostRecentSuccessfulWriteAt",
      "mostRecentWriteError",
      "fillReconciliation",
    ].sort());

    assert.equal(typeof firstStatus["enabled"], "boolean");
    for (const key of ["enqueueAttempts", "successfulWrites", "failedWrites", "queueDrops"]) {
      assert.equal(typeof firstStatus[key], "number");
    }
    for (const key of ["mostRecentEnqueueAt", "mostRecentSuccessfulWriteAt", "mostRecentWriteError"]) {
      assert.ok(firstStatus[key] === null || typeof firstStatus[key] === "string");
    }
    assert.equal(JSON.stringify(firstStatus).includes("phase4b-status-test-token"), false);

    const second = await fetch(`${baseUrl}/trade/phase4b-capture/status`, options);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), firstStatus);
  });
});