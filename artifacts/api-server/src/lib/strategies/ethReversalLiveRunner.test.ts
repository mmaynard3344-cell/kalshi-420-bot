import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH_REVERSAL_SERVICE_EXECUTION_APPROVED,
  isEthReversalServiceExecutionPermitted,
} from "./ethReversalLiveRunner.js";

test("Service C live execution remains hard-disabled even with role and env enabled", () => {
  const prior = process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"];
  process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"] = "true";
  try {
    assert.equal(ETH_REVERSAL_SERVICE_EXECUTION_APPROVED, false);
    assert.equal(isEthReversalServiceExecutionPermitted("reversal"), false);
    assert.equal(isEthReversalServiceExecutionPermitted("jump"), false);
    assert.equal(isEthReversalServiceExecutionPermitted("martingale"), false);
  } finally {
    if (prior == null) delete process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"];
    else process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"] = prior;
  }
});
