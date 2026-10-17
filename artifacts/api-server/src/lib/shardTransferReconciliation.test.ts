import assert from "node:assert/strict";
import { test } from "node:test";
import { assessTransferReconciliation as assess } from "./shardTransferReconciliation.js";

test("acceptance and pending status never imply completion", () => {
  const local = { state: "submitted", exchangeTransferId: "exchange-123" };
  assert.equal(assess(local, null), "manual_review");
  assert.equal(assess(local, { transferId: "exchange-123", status: "pending" }), "no_change");
  assert.equal(assess(local, { transferId: "exchange-123", status: "unknown" }), "manual_review");
});
test("matching exchange ID and explicit normalized completion are required", () => {
  const local = { state: "submitted", exchangeTransferId: "exchange-123" };
  assert.equal(assess(local, { transferId: "exchange-999", status: "confirmed_completed" }), "manual_review");
  assert.equal(assess({ ...local, exchangeTransferId: null }, { transferId: "exchange-123", status: "confirmed_completed" }), "manual_review");
  assert.equal(assess(local, { transferId: "exchange-123", status: "confirmed_completed" }), "eligible_to_complete");
  assert.equal(assess({ ...local, state: "completed" }, { transferId: "exchange-123", status: "confirmed_completed" }), "no_change");
});
