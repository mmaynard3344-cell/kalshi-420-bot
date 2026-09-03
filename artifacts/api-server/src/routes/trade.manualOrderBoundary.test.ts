import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";

// The route reads this once during module initialization. Set it before the
// dynamic import so the request is authenticated and reaches the boundary.
process.env["TRADE_API_TOKEN"] = "manual-order-boundary-test-token";

const { default: tradeRouter } = await import("./trade.js");

describe("POST /trade/order manual-entry boundary", () => {
  const app = express();
  app.use(express.json());
  app.use(tradeRouter);
  const server = http.createServer(app);
  let baseUrl = "";

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  it("rejects an authenticated arbitrary ETH order before any order processing", async () => {
    const response = await fetch(`${baseUrl}/trade/order`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trade-token": "manual-order-boundary-test-token",
      },
      body: JSON.stringify({
        ticker: "KXETH15M-TEST",
        side: "no",
        count: 999,
        outcome_price_cents: 95,
        client_order_id: "manual-bypass-attempt",
      }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "MANUAL_ORDERING_DISABLED",
      message: "Only the ETH martingale strategy may submit new live orders.",
    });
  });
});