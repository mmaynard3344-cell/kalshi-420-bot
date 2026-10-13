import assert from "node:assert/strict";
import test from "node:test";
import { alignEthIntentToG, resolveEthGDirection } from "./ethGDirectionAuthority.js";
import type { EthBigBetOrderIntent } from "./ethBigBetLifecycle.js";

const intent: EthBigBetOrderIntent = {
  strategy: "jump",
  orderTag: "g-direction-review",
  ticker: "KXETH15M-26OCT122145-45",
  side: "no",
  wagerCents: 500,
  limitPriceCents: 50,
  marketOpenTimeMs: 1791855000000,
};

test("G YES takes priority without changing wager, price or market", async () => {
  const result = await alignEthIntentToG(intent, async () => ({ exists: true, side: "yes" }));
  assert.equal(result?.side, "yes");
  assert.equal(result?.strategy, intent.strategy);
  assert.equal(result?.ticker, intent.ticker);
  assert.equal(result?.wagerCents, 500);
  assert.equal(result?.limitPriceCents, 50);
  assert.equal(intent.side, "no");
});

test("G NO takes priority over a competing YES", async () => {
  const result = await alignEthIntentToG({...intent, side:"yes"}, async () => ({ exists: true, side: "no" }));
  assert.equal(result?.side, "no");
});

test("G final no-signal preserves the service's own side", async () => {
  const result = await alignEthIntentToG(intent, async () => ({ exists: true, side: null }));
  assert.equal(result?.side, "no");
  assert.equal(resolveEthGDirection("yes", null), "yes");
});

test("G decision pending prevents an order before G publishes", async () => {
  const result = await alignEthIntentToG(intent, async () => ({ exists: false, side: null }));
  assert.equal(result, null);
});

test("G lookup failure defers the order instead of ignoring G", async () => {
  const result = await alignEthIntentToG(intent, async () => {throw new Error("temporary database outage");});
  assert.equal(result, null);
});
