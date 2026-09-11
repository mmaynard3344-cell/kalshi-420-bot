import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEthServiceEnablement } from "./ethServiceEnablementContract.js";

test("unset role preserves legacy martingale only when B/C live flags are off", () => {
  assert.deepEqual(evaluateEthServiceEnablement({}), {
    valid: true,
    role: null,
    mode: "legacy_martingale",
    reason: null,
  });
  assert.equal(evaluateEthServiceEnablement({ jumpLiveEnabled: "true" }).valid, false);
  assert.equal(evaluateEthServiceEnablement({ reversalLiveEnabled: "true" }).valid, false);
});

test("martingale role rejects B/C live flags", () => {
  assert.equal(evaluateEthServiceEnablement({ rawRole: "martingale" }).mode, "martingale");
  assert.equal(evaluateEthServiceEnablement({ rawRole: "martingale", jumpLiveEnabled: "true" }).valid, false);
  assert.equal(evaluateEthServiceEnablement({ rawRole: "martingale", reversalLiveEnabled: "true" }).valid, false);
});

test("jump role supports staged and exact live-requested modes only", () => {
  assert.equal(evaluateEthServiceEnablement({ rawRole: "jump" }).mode, "jump_staged");
  assert.equal(evaluateEthServiceEnablement({ rawRole: "jump", jumpLiveEnabled: "true" }).mode, "jump_live_requested");
  assert.equal(evaluateEthServiceEnablement({ rawRole: "jump", reversalLiveEnabled: "true" }).valid, false);
});

test("reversal role supports staged and exact live-requested modes only", () => {
  assert.equal(evaluateEthServiceEnablement({ rawRole: "reversal" }).mode, "reversal_staged");
  assert.equal(evaluateEthServiceEnablement({ rawRole: "reversal", reversalLiveEnabled: "true" }).mode, "reversal_live_requested");
  assert.equal(evaluateEthServiceEnablement({ rawRole: "reversal", jumpLiveEnabled: "true" }).valid, false);
});

test("typos, blanks, and dual-live requests fail closed", () => {
  assert.equal(evaluateEthServiceEnablement({ rawRole: "" }).reason, "invalid_service_role");
  assert.equal(evaluateEthServiceEnablement({ rawRole: "jumpp" }).reason, "invalid_service_role");
  assert.equal(evaluateEthServiceEnablement({ rawRole: "jump", jumpLiveEnabled: "true", reversalLiveEnabled: "true" }).reason, "multiple_live_services_requested");
});
