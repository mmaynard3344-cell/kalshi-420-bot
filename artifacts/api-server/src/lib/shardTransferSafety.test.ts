import assert from "node:assert/strict";
import { test } from "node:test";
import { validateShardTransferRequest } from "./shardTransferSafety.js";

const good = {
  sourceExchangeShard: 0,
  destinationExchangeShard: 2,
  amountCents: 2500,
  confirmation: "TRANSFER $25.00 FROM 0 TO 2",
  requestId: "123e4567-e89b-42d3-a456-426614174000",
};
test("accept explicit confirmed 0-to-2 transfer", () => {
  assert.equal(validateShardTransferRequest(good).amountCents, 2500);
});
test("accept explicit confirmed 2-to-0 transfer", () => {
  assert.equal(validateShardTransferRequest({...good, sourceExchangeShard: 2, destinationExchangeShard: 0, confirmation: "TRANSFER $25.00 FROM 2 TO 0"}).sourceExchangeShard, 2);
});
test("reject non-allowlisted destinations and malformed amounts", () => {
  for (const patch of [
    {destinationExchangeShard: 1},
    {sourceExchangeShard: 2, destinationExchangeShard: 2},
    {amountCents: 2500.1},
    {amountCents: -1},
    {amountCents: 100001},
    {amountCents: "2500"},
    {confirmation: "yes"},
    {requestId: "repeat"},
  ]) assert.throws(() => validateShardTransferRequest({...good,...patch}));
});
