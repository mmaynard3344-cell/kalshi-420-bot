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

test("reverse direction maps exactly to shard 2 to shard 0", () => {
  const payload = buildShardTransferPayload({
    ...request,
    sourceExchangeShard: 2, destinationExchangeShard: 0,
    confirmation: "TRANSFER $25.00 FROM 2 TO 0",
  });
  assert.equal(payload.source_exchange_shard, 2);
  assert.equal(payload.destination_exchange_shard, 0);
  assert.equal(payload.source, "event_contract");
  assert.equal(payload.destination, "event_contract");
});
test("rejects an amount exceeding the operator transfer limit", () => {
  assert.throws(() => buildShardTransferPayload({
    ...request, amountCents: 100001,
    confirmation: "TRANSFER $1000.01 FROM 0 TO 2",
  }));
});
