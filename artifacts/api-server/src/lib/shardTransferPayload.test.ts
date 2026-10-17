import assert from "node:assert/strict";
import { test } from "node:test";
import { buildShardTransferPayload } from "./shardTransferPayload.js";
const request = {
  sourceExchangeShard: 0,
  destinationExchangeShard: 2,
  amountCents: 2500,
  confirmation: "TRANSFER $25.00 FROM 0 TO 2",
  requestId: "123e4567-e89b-42d3-a456-426614174000",
};
test("converts $25 to 250000 centicents", () => {
  const payload = buildShardTransferPayload(request);
  assert.equal(payload.amount, 250000);
  assert.equal(payload.source_exchange_shard, 0);
  assert.equal(payload.destination_exchange_shard, 2);
});
test("retains cent precision for a one cent transfer", () => {
  assert.equal(buildShardTransferPayload({
    ...request, amountCents: 1, confirmation: "TRANSFER $0.01 FROM 0 TO 2",
  }).amount, 100);
});
test("rejects transfers without exact matching confirmation", () => {
  assert.throws(() => buildShardTransferPayload({...request, confirmation: "yes"}));
});
