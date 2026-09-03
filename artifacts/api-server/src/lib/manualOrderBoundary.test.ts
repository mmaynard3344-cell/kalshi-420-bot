import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isManualNewOrderSubmissionDisabled } from "./manualOrderBoundary.js";

describe("manual exchange-order boundary", () => {
  it("rejects arbitrary ETH 15-minute order submissions before they can reach an exchange POST", () => {
    assert.equal(
      isManualNewOrderSubmissionDisabled(),
      true,
      "a KXETH15M request with caller-selected side, price, and count must not bypass the martingale",
    );
  });
});