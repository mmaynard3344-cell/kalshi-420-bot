import assert from "node:assert/strict";
import test from "node:test";
import {
  ETH_BREAKOUT_REVERSAL_SERVICE_EXECUTION_APPROVED,
  isEthReversalServiceExecutionPermitted,
} from "./ethReversalLiveRunner.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

test("Service D execution requires exact reversal role and isolated live flag", () => {
  const priorRole = process.env["ETH_SERVICE_ROLE"];
  const priorJump = process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"];
  const priorReversal = process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"];
  const priorBreakout = process.env["ETH_BREAKOUT_REVERSAL_SERVICE_LIVE_ENABLED"];
  try {
    assert.equal(ETH_BREAKOUT_REVERSAL_SERVICE_EXECUTION_APPROVED, true);
    process.env["ETH_SERVICE_ROLE"] = "reversal";
    process.env["ETH_BREAKOUT_REVERSAL_SERVICE_LIVE_ENABLED"] = "true";
    delete process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"];
    delete process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"];
    assert.equal(isEthReversalServiceExecutionPermitted("reversal"), true);
    assert.equal(isEthReversalServiceExecutionPermitted("jump"), false);
    assert.equal(isEthReversalServiceExecutionPermitted("martingale"), false);

    process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"] = "true";
    assert.equal(isEthReversalServiceExecutionPermitted("reversal"), false);
    delete process.env["ETH_REVERSAL_SERVICE_LIVE_ENABLED"];
    process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"] = "true";
    assert.equal(isEthReversalServiceExecutionPermitted("reversal"), false);
    delete process.env["ETH_JUMP_SERVICE_LIVE_ENABLED"];
    process.env["ETH_BREAKOUT_REVERSAL_SERVICE_LIVE_ENABLED"] = "false";
    assert.equal(isEthReversalServiceExecutionPermitted("reversal"), false);
  } finally {
    restoreEnv("ETH_SERVICE_ROLE", priorRole);
    restoreEnv("ETH_JUMP_SERVICE_LIVE_ENABLED", priorJump);
    restoreEnv("ETH_REVERSAL_SERVICE_LIVE_ENABLED", priorReversal);
    restoreEnv("ETH_BREAKOUT_REVERSAL_SERVICE_LIVE_ENABLED", priorBreakout);
  }
});
