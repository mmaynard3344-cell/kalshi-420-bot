import assert from "node:assert/strict";
import { test } from "node:test";
import { maySubmitTransfer, updateTransferState, type ShardTransferRecord } from "./shardTransferIdempotency.js";

const reserved: ShardTransferRecord = {
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  state: "reserved",
  exchangeTransferId: null,
};
test("only a never-before-seen request can be submitted", () => {
  assert.equal(maySubmitTransfer(null), true);
  for (const state of ["reserved", "submitting", "submitted", "completed", "failed", "unknown"] as const) {
    assert.equal(maySubmitTransfer({ ...reserved, state }), false);
  }
});
test("a timeout stays unknown and must never trigger automatic resubmission", () => {
  const submitting = updateTransferState(reserved, "submitting");
  const unknown = updateTransferState(submitting, "unknown");
  assert.equal(maySubmitTransfer(unknown), false);
  assert.throws(() => updateTransferState(unknown, "submitting"));
});
test("submitted transfer requires exchange ID", () => {
  assert.throws(() => updateTransferState(updateTransferState(reserved, "submitting"), "submitted"));
  const submitted = updateTransferState(updateTransferState(reserved, "submitting"), "submitted", "exchange-id");
  assert.equal(updateTransferState(submitted, "completed").state, "completed");
  assert.throws(() => updateTransferState(updateTransferState(submitted, "completed"), "submitting"));
});
