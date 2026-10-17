import assert from "node:assert/strict";
import { test } from "node:test";
import { describeShardTransferStatus } from "./shardTransferStatusView.js";
test("accepted transfer is never shown as arrived", () => {
 const status=describeShardTransferStatus({state:"submitted",exchange_transfer_id:"abc"});
 assert.equal(status.fundsArrived,false);
 assert.match(status.message,/not yet verified/);
});
test("unknown transfer requires reconciliation; completed is distinct", () => {
 assert.equal(describeShardTransferStatus({state:"unknown"}).requiresReconciliation,true);
 assert.equal(describeShardTransferStatus({state:"completed"}).fundsArrived,false);
 assert.equal(describeShardTransferStatus({state:"completed",exchange_transfer_id:"verified-id"}).fundsArrived,true);
 assert.throws(()=>describeShardTransferStatus({state:"arrived"}),/Unrecognized/);
});