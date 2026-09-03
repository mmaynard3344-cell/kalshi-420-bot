import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMartingaleEntryExplicitlyPermitted } from "./martingaleStatus";

describe("martingale status display permission", () => {
  it("shows active only after every server gate explicitly permits ETH entry", () => {
    assert.equal(isMartingaleEntryExplicitlyPermitted({
      trading_halted: false,
      environment_lock: false,
      eth_order_submission_permitted: true,
      eth_order_submission_reason: "permitted",
    }), true);
  });

  it("keeps missing, halted, locked, and partial status responses non-active", () => {
    assert.equal(isMartingaleEntryExplicitlyPermitted(undefined), false);
    assert.equal(isMartingaleEntryExplicitlyPermitted({
      trading_halted: false,
      environment_lock: false,
    }), false);
    assert.equal(isMartingaleEntryExplicitlyPermitted({
      trading_halted: true,
      environment_lock: false,
      eth_order_submission_permitted: true,
      eth_order_submission_reason: "permitted",
    }), false);
    assert.equal(isMartingaleEntryExplicitlyPermitted({
      trading_halted: false,
      environment_lock: true,
      eth_order_submission_permitted: true,
      eth_order_submission_reason: "permitted",
    }), false);
  });
});