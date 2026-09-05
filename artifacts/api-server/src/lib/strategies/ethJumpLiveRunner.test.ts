import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH_JUMP_SERVICE_EXECUTION_APPROVED,
  isEthJumpServiceExecutionPermitted,
} from "./ethJumpLiveRunner.js";
import {
  _setEthBigBetAuthFetchForTesting,
  createEthBigBetKalshiSubmitter,
} from "./ethBigBetKalshiExchange.js";

test("Service B live execution remains hard-disabled even with role and env enabled", () => {
  const prior = process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"];
  process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"] = "true";
  try {
    assert.equal(ETH_JUMP_SERVICE_EXECUTION_APPROVED, false);
    assert.equal(isEthJumpServiceExecutionPermitted("jump"), false);
    assert.equal(isEthJumpServiceExecutionPermitted("martingale"), false);
  } finally {
    if (prior == null) delete process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"];
    else process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"] = prior;
  }
});

test("B/C Kalshi adapter uses isolated fixed-price GTC payload and exact identity", async () => {
  const payloads: Array<Record<string, unknown>> = [];
  _setEthBigBetAuthFetchForTesting((async (_method: string, path: string, body?: unknown) => {
    assert.equal(path, "/portfolio/events/orders");
    payloads.push(body as Record<string, unknown>);
    return {
      order: {
        order_id: "kalshi-b-1",
        client_order_id: "KXETH15M-X:eth-jump-v1",
        ticker: "KXETH15M-X",
        status: "resting",
        fill_count: 0,
      },
    };
  }) as any);
  try {
    const exchange = createEthBigBetKalshiSubmitter(2);
    assert.ok(exchange);
    const result = await exchange!.submit({
      clientOrderId: "KXETH15M-X:eth-jump-v1",
      ticker: "KXETH15M-X",
      side: "no",
      contracts: 840,
      limitPriceCents: 50,
    });
    assert.deepEqual(result, { kind: "accepted", exchangeOrderId: "kalshi-b-1" });
    assert.deepEqual(payloads[0], {
      ticker: "KXETH15M-X",
      client_order_id: "KXETH15M-X:eth-jump-v1",
      side: "ask",
      count: "840.00",
      price: "0.5000",
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      exchange_index: 2,
    });
  } finally {
    _setEthBigBetAuthFetchForTesting(null);
  }
});

test("ambiguous or thrown B/C POST remains submission_unknown evidence", async () => {
  _setEthBigBetAuthFetchForTesting((async () => { throw new Error("transport lost"); }) as any);
  try {
    const exchange = createEthBigBetKalshiSubmitter(1);
    assert.ok(exchange);
    assert.deepEqual(await exchange!.submit({
      clientOrderId: "KXETH15M-X:eth-jump-v1",
      ticker: "KXETH15M-X",
      side: "yes",
      contracts: 840,
      limitPriceCents: 50,
    }), { kind: "unknown" });
  } finally {
    _setEthBigBetAuthFetchForTesting(null);
  }
  assert.equal(createEthBigBetKalshiSubmitter(-1), null);
});
