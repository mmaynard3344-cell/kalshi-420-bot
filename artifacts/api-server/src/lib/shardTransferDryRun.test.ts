import assert from "node:assert/strict";
import { test } from "node:test";
import { previewManualShardTransfer } from "./shardTransferDryRun.js";
test("preview formats a transfer without executing it", () => {
  const response=previewManualShardTransfer({
    requestId:"69e61066-4170-4eb4-bfca-1b33800ca633",
    sourceExchangeShard:0,destinationExchangeShard:2,
    amountCents:100,confirmation:"TRANSFER $1.00 FROM 0 TO 2",
  });
  assert.equal(response.exchangeAmount,10000);
  assert.equal(response.wouldSubmit,false);
});
